import type { AhClient, StoreProduct } from "@shopai/connector-ah";
import { normalizeName, type Logger } from "@shopai/core";
import { extractJson } from "@shopai/llm";
import {
  and,
  desc,
  eq,
  products as productsTable,
  productAliases,
  type Db,
} from "@shopai/db";
import type { ZagiClient } from "@shopai/llm";

export interface MatchCandidate {
  product: StoreProduct;
  reason: string;
}

export interface MatchResult {
  /** The chosen product, or null when nothing suitable was found. */
  chosen: StoreProduct | null;
  reason: string;
  /** How the choice was made. */
  via: "alias" | "previously_bought" | "llm" | "top" | "none";
  /** Candidates to offer the user when confidence is low. */
  candidates: StoreProduct[];
  /** True when the caller should ask the user to pick from candidates. */
  needsChoice: boolean;
}

export interface MatcherDeps {
  db: Db;
  log: Logger;
  llm: ZagiClient | null;
}

export async function cacheProducts(db: Db, list: StoreProduct[]): Promise<void> {
  if (list.length === 0) return;
  for (const p of list) {
    await db
      .insert(productsTable)
      .values({
        store: p.store,
        productId: p.id,
        title: p.title,
        brand: p.brand,
        size: p.size,
        price: p.price === null ? null : String(p.price),
        priceBeforeBonus: p.priceBeforeBonus === null ? null : String(p.priceBeforeBonus),
        unitPrice: p.unitPrice,
        isBonus: p.isBonus,
        bonusUntil: p.bonusUntil,
        category: p.category,
        imageUrl: p.imageUrl,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [productsTable.store, productsTable.productId],
        set: {
          title: p.title,
          brand: p.brand,
          size: p.size,
          price: p.price === null ? null : String(p.price),
          priceBeforeBonus: p.priceBeforeBonus === null ? null : String(p.priceBeforeBonus),
          unitPrice: p.unitPrice,
          isBonus: p.isBonus,
          bonusUntil: p.bonusUntil,
          category: p.category,
          imageUrl: p.imageUrl,
          fetchedAt: new Date(),
        },
      });
  }
}

async function lockedAlias(db: Db, householdId: number, nameNorm: string): Promise<string | null> {
  const rows = await db
    .select({ productId: productAliases.productId, locked: productAliases.locked, score: productAliases.score })
    .from(productAliases)
    .where(and(eq(productAliases.householdId, householdId), eq(productAliases.store, "ah"), eq(productAliases.nameNorm, nameNorm)))
    .orderBy(desc(productAliases.locked), desc(productAliases.score))
    .limit(1);
  return rows[0]?.productId ?? null;
}

export async function rememberAlias(
  db: Db,
  householdId: number,
  name: string,
  productId: string,
  source: "human" | "order" | "llm",
): Promise<void> {
  const nameNorm = normalizeName(name);
  await db
    .insert(productAliases)
    .values({ householdId, nameNorm, store: "ah", productId, source, locked: source === "human", score: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [productAliases.householdId, productAliases.store, productAliases.nameNorm],
      set: {
        productId,
        source,
        locked: source === "human",
        score: source === "human" ? 100 : 1,
        updatedAt: new Date(),
      },
    });
}

/**
 * Resolve one list item to a store product.
 * Order: locked/known alias -> AH search -> (previously bought | LLM pick | top),
 * asking the user only when the LLM is unsure or unavailable and the result is ambiguous.
 */
export async function matchItem(
  deps: MatcherDeps,
  ah: AhClient,
  householdId: number,
  item: { name: string; qty?: number | null; unit?: string | null },
): Promise<MatchResult> {
  const nameNorm = normalizeName(item.name);

  const aliasId = await lockedAlias(deps.db, householdId, nameNorm);
  if (aliasId) {
    const p = await ah.product(aliasId).catch(() => null);
    if (p && p.orderable) return { chosen: p, reason: "your usual choice", via: "alias", candidates: [p], needsChoice: false };
  }

  let results: StoreProduct[] = [];
  try {
    results = await ah.search(item.name, { size: 5 });
  } catch (err) {
    deps.log.warn({ err, item: item.name }, "AH search failed");
    return { chosen: null, reason: "search failed", via: "none", candidates: [], needsChoice: false };
  }
  const orderable = results.filter((p) => p.orderable);
  await cacheProducts(deps.db, orderable);
  if (orderable.length === 0) return { chosen: null, reason: "nothing found", via: "none", candidates: [], needsChoice: false };

  const bought = orderable.find((p) => p.previouslyBought);
  if (bought) return { chosen: bought, reason: "bought before", via: "previously_bought", candidates: orderable, needsChoice: false };

  if (orderable.length === 1) {
    return { chosen: orderable[0]!, reason: "only match", via: "top", candidates: orderable, needsChoice: false };
  }

  if (deps.llm) {
    const pick = await llmPick(deps, item, orderable).catch((err) => {
      deps.log.warn({ err }, "LLM pick failed");
      return null;
    });
    if (pick && pick.index >= 0 && pick.index < orderable.length && pick.confident) {
      return { chosen: orderable[pick.index]!, reason: pick.reason || "best match", via: "llm", candidates: orderable, needsChoice: false };
    }
  }

  // Ambiguous and no confident automatic pick: ask.
  return { chosen: null, reason: "needs a choice", via: "none", candidates: orderable.slice(0, 3), needsChoice: true };
}

async function llmPick(
  deps: MatcherDeps,
  item: { name: string; qty?: number | null; unit?: string | null },
  candidates: StoreProduct[],
): Promise<{ index: number; confident: boolean; reason: string } | null> {
  const llm = deps.llm!;
  const list = candidates
    .map((p, i) => `${i}: ${p.title} | brand ${p.brand ?? "?"} | ${p.size ?? "?"} | €${p.price ?? "?"}${p.isBonus ? " (bonus)" : ""}`)
    .join("\n");
  const want = `${item.name}${item.qty ? ` qty ${item.qty}` : ""}${item.unit ? ` ${item.unit}` : ""}`;
  const res = await llm.chatWithBudget({
    messages: [
      {
        role: "system",
        content:
          "You pick the single best Albert Heijn product for a shopping-list item for a family. Prefer the plain everyday version and a sensible size; avoid tiny/sample sizes and oddly expensive specialities unless asked. Reply with ONLY JSON: {\"index\": <n>, \"confident\": <bool>, \"reason\": \"<short>\"}. Set confident=false if none clearly fits.",
      },
      { role: "user", content: `Item wanted: ${want}\nCandidates:\n${list}` },
    ],
    maxTokens: 4000,
    temperature: 0,
  });
  const parsed = extractJson<{ index?: number; confident?: boolean; reason?: string }>(res.text);
  if (typeof parsed.index !== "number") return null;
  return { index: parsed.index, confident: Boolean(parsed.confident), reason: String(parsed.reason ?? "") };
}
