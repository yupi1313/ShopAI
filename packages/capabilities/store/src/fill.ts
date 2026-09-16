import type { AhClient, StoreProduct } from "@shopai/connector-ah";
import { getOpenItems } from "@shopai/capability-grocery";
import type { Db, ListItem } from "@shopai/db";
import { matchItem, rememberAlias, type MatcherDeps } from "./matcher.js";

export interface FillPick {
  item: ListItem;
  product: StoreProduct;
  reason: string;
  via: string;
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

/** Match every open, not-yet-basketed list item to an AH product. Reads only. */
export async function planFill(
  deps: MatcherDeps,
  ah: AhClient,
  householdId: number,
  listId: number,
): Promise<FillPlan> {
  const items = (await getOpenItems(deps.db, listId)).filter((i) => i.status === "pending");
  const plan: FillPlan = { picks: [], choices: [], notFound: [] };
  for (const item of items) {
    const m = await matchItem(deps, ah, householdId, { name: item.nameRaw, qty: item.qty ? Number(item.qty) : null, unit: item.unit });
    if (m.chosen) plan.picks.push({ item, product: m.chosen, reason: m.reason, via: m.via });
    else if (m.needsChoice && m.candidates.length) plan.choices.push({ item, candidates: m.candidates });
    else plan.notFound.push(item);
  }
  return plan;
}

export interface FillExecResult {
  added: Array<{ name: string; product: string; price: number | null }>;
  failed: Array<{ name: string; error: string }>;
  choices: FillChoice[];
  notFound: string[];
}

/**
 * Execute a fill: add each confident pick to the AH shopping list and mark the
 * list item in_basket. Runs only after a human confirm. Quantity: the AH list
 * uses whole units, so a numeric qty rounds up to at least 1.
 */
export async function executeFill(
  deps: MatcherDeps & { setInBasket(ids: number[]): Promise<void> },
  ah: AhClient,
  householdId: number,
  plan: FillPlan,
): Promise<FillExecResult> {
  const out: FillExecResult = { added: [], failed: [], choices: plan.choices, notFound: plan.notFound.map((i) => i.nameRaw) };
  const done: number[] = [];
  for (const pick of plan.picks) {
    const qty = pick.item.qty ? Math.max(1, Math.ceil(Number(pick.item.qty))) : 1;
    try {
      await ah.shoppingListAdd(Number(pick.product.id), qty);
      out.added.push({ name: pick.item.nameRaw, product: pick.product.title, price: pick.product.price });
      done.push(pick.item.id);
      // A confident automatic pick becomes a soft alias so next time is instant.
      if (pick.via === "llm" || pick.via === "previously_bought") {
        await rememberAlias(deps.db, householdId, pick.item.nameRaw, pick.product.id, pick.via === "previously_bought" ? "order" : "llm");
      }
    } catch (err) {
      out.failed.push({ name: pick.item.nameRaw, error: err instanceof Error ? err.message : "add failed" });
    }
  }
  if (done.length) await deps.setInBasket(done);
  return out;
}
