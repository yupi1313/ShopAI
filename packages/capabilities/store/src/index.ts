import { z } from "zod";
import { defineTool, type Capability, type ToolContext } from "@shopai/core";
import type { ZagiClient } from "@shopai/llm";
import { getActiveList } from "@shopai/capability-grocery";
import { AH_AUTHORIZE_URL, productDeepLink } from "@shopai/connector-ah";
import { accountStatus, buildClient, tokenSource, type StoreDeps } from "./account.js";
import { cacheProducts, matchItem, rememberAlias } from "./matcher.js";
import { planFill } from "./fill.js";

export * from "./account.js";
export { planFill } from "./fill.js";
export { matchItem, rememberAlias } from "./matcher.js";
export { AH_AUTHORIZE_URL } from "@shopai/connector-ah";

export interface StoreCapabilityDeps {
  sessionSecret: string;
  llm: ZagiClient | null;
  fetchImpl?: typeof fetch;
}

// AH gates automated writes to the shopping list behind an app-only signed
// request we can't reproduce, so the bot produces one-tap add links instead of
// writing directly. No shop-side-effect tools for now.
export const STORE_SHOP_TOOLS = new Set<string>();

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
          : "AH is not connected. To connect, the admin sends /store ah in a private chat with me and follows the steps. Search still works without connecting.";
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
      if (!(await ts.isMember())) return { connected: false, hint: "AH not connected; admin runs /store ah to connect." };
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const list = await ah.shoppingList();
      return { connected: true, count: list.items.length, items: list.items.map((i) => ({ qty: i.quantity, name: i.description })) };
    },
  });

  const basketAdd = defineTool({
    name: "basket_add",
    description: "Give a one-tap Albert Heijn link to add a product (by numeric id from store_search) to the AH basket. The user taps it in the AH app to add and check out. (AH does not allow the bot to write the basket directly.)",
    schema: z.object({ id: z.union([z.string(), z.number()]), qty: z.number().int().min(1).max(99).optional() }),
    sideEffect: "none",
    async handler(args, ctx) {
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const p = await ah.product(String(args.id)).catch(() => null);
      return {
        title: p ? p.title : String(args.id),
        price: p ? money(p.price) : null,
        addLink: productDeepLink(args.id),
        note: "Tap the link, then add it in the AH app.",
      };
    },
  });

  const basketFill = defineTool({
    name: "basket_fill_from_list",
    description: "Match every open item on the shopping list to an Albert Heijn product and return a one-tap add link and price for each. The user taps the links in the AH app to build the basket and check out. Items needing a choice or not found are reported back.",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const list = await getActiveList(ctx.db, ctx.household.id);
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const plan = await planFill(matcherDeps(ctx), ah, ctx.household.id, list.id);
      // Remember confident picks as soft aliases so the choice is stable next time.
      for (const pick of plan.picks) {
        if (pick.via === "llm" || pick.via === "previously_bought") {
          await rememberAlias(ctx.db, ctx.household.id, pick.item.nameRaw, pick.product.id, pick.via === "previously_bought" ? "order" : "llm").catch(() => {});
        }
      }
      return {
        picks: plan.picks.map((p) => ({ item: p.item.nameRaw, product: p.product.title, price: money(p.product.price), reason: p.reason, addLink: productDeepLink(p.product.id) })),
        needChoice: plan.choices.map((c) => ({ item: c.item.nameRaw, options: c.candidates.map((o) => ({ title: o.title, price: money(o.price), addLink: productDeepLink(o.id) })) })),
        notFound: plan.notFound.map((i) => i.nameRaw),
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
        ? "Albert Heijn is connected. You can search AH (real prices, bonus, previously-bought) and read the AH list. AH does not let the bot write the basket directly, so basket_add and basket_fill_from_list return one-tap add links with prices; the user taps them in the AH app to add and check out. Present the links clearly, grouped, with prices. You never pay."
        : "Albert Heijn is NOT connected yet. Search works; to use add-links the admin connects it with /store ah.";
    return `Store: ${line}`;
  }

  return {
    name: "store",
    tools: [storeStatus, storeSearch, storeProduct, basketView, basketAdd, basketFill, purchasesOf] as Capability["tools"],
    promptFragment,
  };
}
