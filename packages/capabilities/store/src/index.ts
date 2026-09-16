import { z } from "zod";
import { defineTool, type Capability, type ToolContext } from "@shopai/core";
import type { ZagiClient } from "@shopai/llm";
import { getActiveList, getOpenItems, setStatus } from "@shopai/capability-grocery";
import { AH_AUTHORIZE_URL } from "@shopai/connector-ah";
import { accountStatus, buildClient, tokenSource, type StoreDeps } from "./account.js";
import { cacheProducts, matchItem, rememberAlias } from "./matcher.js";
import { executeFill, planFill } from "./fill.js";

export * from "./account.js";
export { planFill, executeFill } from "./fill.js";
export { matchItem, rememberAlias } from "./matcher.js";
export { AH_AUTHORIZE_URL } from "@shopai/connector-ah";

export interface StoreCapabilityDeps {
  sessionSecret: string;
  llm: ZagiClient | null;
  fetchImpl?: typeof fetch;
}

/** Tools that add to the AH shopping list; the bot re-shows the plan/list after. */
export const STORE_SHOP_TOOLS = new Set(["basket_add", "basket_fill_from_list"]);

function money(n: number | null): string {
  return n === null ? "?" : `€${n.toFixed(2)}`;
}

export function createStoreCapability(cfgDeps: StoreCapabilityDeps): Capability {
  const storeDeps = (ctx: ToolContext): StoreDeps => ({ db: ctx.db, sessionSecret: cfgDeps.sessionSecret, fetchImpl: cfgDeps.fetchImpl });
  const matcherDeps = (ctx: ToolContext) => ({ db: ctx.db, log: ctx.log, llm: cfgDeps.llm });

  const storeStatus = defineTool({
    name: "store_status",
    description: "Check whether the Albert Heijn account is connected. Use before basket actions or when the user asks about connecting the store.",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const status = await accountStatus(ctx.db, ctx.household.id);
      const hint =
        status === "connected"
          ? "AH is connected; I can search products and add them to your AH shopping list."
          : "AH is not connected. To connect, the admin sends /store in a private chat with me and follows the steps. Search still works without connecting.";
      return { status, hint };
    },
  });

  const storeSearch = defineTool({
    name: "store_search",
    description: "Search Albert Heijn for products by name. Returns up to 5 with id, brand, size, price and whether it is on bonus. Use to answer 'what does X cost at AH' or to find something to add to the basket.",
    schema: z.object({ query: z.string().min(1).max(120), limit: z.number().int().min(1).max(5).optional() }),
    sideEffect: "none",
    async handler(args, ctx) {
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const results = await ah.search(args.query, { size: args.limit ?? 5 });
      await cacheProducts(ctx.db, results);
      return results.map((p) => ({
        id: p.id,
        title: p.title,
        brand: p.brand,
        size: p.size,
        price: money(p.price),
        wasPrice: p.isBonus ? money(p.priceBeforeBonus) : undefined,
        bonus: p.isBonus || undefined,
        unitPrice: p.unitPrice,
        previouslyBought: p.previouslyBought || undefined,
        orderable: p.orderable,
      }));
    },
  });

  const storeProduct = defineTool({
    name: "store_product",
    description: "Get one Albert Heijn product by its numeric id (from store_search).",
    schema: z.object({ id: z.union([z.string(), z.number()]) }),
    sideEffect: "none",
    async handler(args, ctx) {
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const p = await ah.product(String(args.id));
      if (!p) return { error: "not found" };
      await cacheProducts(ctx.db, [p]);
      return { id: p.id, title: p.title, brand: p.brand, size: p.size, price: money(p.price), bonus: p.isBonus, unitPrice: p.unitPrice, orderable: p.orderable };
    },
  });

  const basketView = defineTool({
    name: "basket_view",
    description: "Show what is currently on the Albert Heijn shopping list (what a family member would turn into a basket in the AH app).",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const ts = tokenSource(storeDeps(ctx), ctx.household.id);
      if (!(await ts.isMember())) return { connected: false, hint: "AH not connected; admin runs /store to connect." };
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const list = await ah.shoppingList();
      return { connected: true, count: list.items.length, items: list.items.map((i) => ({ qty: i.quantity, name: i.description })) };
    },
  });

  const basketAdd = defineTool({
    name: "basket_add",
    description: "Add one Albert Heijn product (by numeric id from store_search) to the AH shopping list. Requires the user to confirm.",
    schema: z.object({ id: z.union([z.string(), z.number()]), qty: z.number().int().min(1).max(99).optional() }),
    sideEffect: "shop",
    async handler(args, ctx) {
      // Runs only after confirmation.
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const qty = args.qty ?? 1;
      await ah.shoppingListAdd(Number(args.id), qty);
      const p = await ah.product(String(args.id)).catch(() => null);
      return { added: p ? p.title : String(args.id), qty };
    },
  });

  const basketFill = defineTool({
    name: "basket_fill_from_list",
    description: "Match every open item on the shopping list to an Albert Heijn product and add them to the AH shopping list. Requires the user to confirm; items needing a choice or not found are reported back.",
    schema: z.object({}),
    sideEffect: "shop",
    async handler(_args, ctx) {
      // Runs only after confirmation.
      const list = await getActiveList(ctx.db, ctx.household.id);
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const plan = await planFill(matcherDeps(ctx), ah, ctx.household.id, list.id);
      const res = await executeFill(
        {
          ...matcherDeps(ctx),
          async setInBasket(ids: number[]) {
            await setStatus(ctx.db, list.id, ids, "in_basket");
          },
        },
        ah,
        ctx.household.id,
        plan,
      );
      return {
        added: res.added.map((a) => `${a.name} → ${a.product} (${money(a.price)})`),
        needChoice: res.choices.map((c) => c.item.nameRaw),
        notFound: res.notFound,
        failed: res.failed,
      };
    },
  });

  const purchasesOf = defineTool({
    name: "purchases_of",
    description: "Find which Albert Heijn product the family usually buys for a given item (e.g. 'pasta', 'coffee'), using saved preferences and AH's previously-bought flag.",
    schema: z.object({ item: z.string().min(1).max(120) }),
    sideEffect: "none",
    async handler(args, ctx) {
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const m = await matchItem(matcherDeps(ctx), ah, ctx.household.id, { name: args.item });
      if (m.chosen) return { usual: { id: m.chosen.id, title: m.chosen.title, brand: m.chosen.brand, size: m.chosen.size, price: money(m.chosen.price) }, reason: m.reason };
      if (m.candidates.length) return { unsure: true, options: m.candidates.map((p) => ({ id: p.id, title: p.title, price: money(p.price) })) };
      return { none: true };
    },
  });

  async function promptFragment(ctx: ToolContext): Promise<string> {
    const status = await accountStatus(ctx.db, ctx.household.id);
    const line =
      status === "connected"
        ? "Albert Heijn is connected. You can search AH and, after the user confirms, add products to the AH shopping list (basket_add, basket_fill_from_list). You never pay; a family member opens the AH app and checks out."
        : "Albert Heijn is NOT connected yet. Search works, but to add to the AH basket the admin must connect it with /store. If asked to fill the basket, say it needs connecting first.";
    return `Store: ${line}`;
  }

  return {
    name: "store",
    tools: [storeStatus, storeSearch, storeProduct, basketView, basketAdd, basketFill, purchasesOf] as Capability["tools"],
    promptFragment,
  };
}
