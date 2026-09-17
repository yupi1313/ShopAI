import type { AhClient, StoreProduct } from "@shopai/connector-ah";
import { getOpenItems } from "@shopai/capability-grocery";
import type { ListItem } from "@shopai/db";
import { matchItem, rememberAlias, type MatcherDeps } from "./matcher.js";

export interface FillPick {
  item: ListItem;
  product: StoreProduct;
  reason: string;
  via: string;
  /** Units to put in the basket for this line. */
  qty: number;
}
export interface FillChoice {
  item: ListItem;
  candidates: StoreProduct[];
}
export interface FillPlan {
  picks: FillPick[];
  choices: FillChoice[];
  notFound: ListItem[];
}

/** The AH basket counts whole units, so a numeric qty rounds up to at least 1. */
export function unitsFor(item: ListItem): number {
  return item.qty ? Math.max(1, Math.ceil(Number(item.qty))) : 1;
}

/** Match every open, not-yet-basketed list item to an AH product. Reads only. */
export async function planFill(deps: MatcherDeps, ah: AhClient, householdId: number, listId: number): Promise<FillPlan> {
  const items = (await getOpenItems(deps.db, listId)).filter((i) => i.status === "pending");
  const plan: FillPlan = { picks: [], choices: [], notFound: [] };
  for (const item of items) {
    const m = await matchItem(deps, ah, householdId, { name: item.nameRaw, qty: item.qty ? Number(item.qty) : null, unit: item.unit });
    if (m.chosen) plan.picks.push({ item, product: m.chosen, reason: m.reason, via: m.via, qty: unitsFor(item) });
    else if (m.needsChoice && m.candidates.length) plan.choices.push({ item, candidates: m.candidates });
    else plan.notFound.push(item);
  }
  return plan;
}

export interface FillExecResult {
  added: Array<{ name: string; product: string; productId: number; qty: number; now: number; price: number | null }>;
  failed: Array<{ name: string; error: string }>;
  choices: FillChoice[];
  notFound: string[];
  basketTotal: string | null;
}

/**
 * Execute a fill: put every confident pick in the AH basket with ONE
 * basketItemsUpdate (quantities are absolute, so existing lines are read
 * first and added to), then mark the list items in_basket. Runs after the
 * user tapped the Confirm button.
 */
export async function executeFill(
  deps: MatcherDeps & { setInBasket(ids: number[]): Promise<void> },
  ah: AhClient,
  householdId: number,
  plan: FillPlan,
): Promise<FillExecResult> {
  const out: FillExecResult = { added: [], failed: [], choices: plan.choices, notFound: plan.notFound.map((i) => i.nameRaw), basketTotal: null };
  if (plan.picks.length === 0) return out;

  const current = await ah.basket().catch(() => null);
  const existing = new Map<number, number>();
  for (const line of current?.items ?? []) if (line.productId !== null) existing.set(line.productId, line.quantity);

  const wanted = new Map<number, number>();
  for (const pick of plan.picks) {
    const pid = Number(pick.product.id);
    wanted.set(pid, (wanted.get(pid) ?? existing.get(pid) ?? 0) + pick.qty);
  }

  try {
    const basket = await ah.basketItemsUpdate([...wanted].map(([productId, quantity]) => ({ productId, quantity })));
    out.basketTotal = basket.totalFormatted ?? (basket.totalPrice === null ? null : `€${basket.totalPrice.toFixed(2)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "add failed";
    for (const pick of plan.picks) out.failed.push({ name: pick.item.nameRaw, error: msg });
    return out;
  }

  const done: number[] = [];
  for (const pick of plan.picks) {
    const pid = Number(pick.product.id);
    out.added.push({ name: pick.item.nameRaw, product: pick.product.title, productId: pid, qty: pick.qty, now: wanted.get(pid) ?? pick.qty, price: pick.product.price });
    done.push(pick.item.id);
    // A confident automatic pick becomes a soft alias so next time is instant.
    if (pick.via === "llm" || pick.via === "previously_bought") {
      await rememberAlias(deps.db, householdId, pick.item.nameRaw, pick.product.id, pick.via === "previously_bought" ? "order" : "llm").catch(() => {});
    }
  }
  await deps.setInBasket(done);
  return out;
}
