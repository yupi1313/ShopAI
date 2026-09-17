import { z } from "zod";
import { defineTool, type Capability, type ToolContext } from "@shopai/core";
import type { ZagiClient } from "@shopai/llm";
import { getActiveList, setStatus } from "@shopai/capability-grocery";
import { AH_AUTHORIZE_URL, productDeepLink, type AhBasket } from "@shopai/connector-ah";
import { and, eq, inArray, products as productsTable } from "@shopai/db";
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
  /**
   * Write to the family's AH basket through AH's GraphQL API (api.ah.nl/graphql,
   * mutation basketItemsUpdate). Adds and clears wait for a Confirm button
   * that names the product, quantity and price; removals run at once (the
   * family's rule: "show me what goes in, I can take it out"). The bot never
   * checks out. Off = the bot only hands out one-tap links.
   */
  basketWrite?: boolean;
}

/** Tools that change the AH basket and wait for the Confirm button. */
export const STORE_SHOP_TOOLS = new Set(["basket_add", "basket_fill_from_list", "basket_clear"]);

/** Tools whose result carries `changes: BasketChange[]`; interfaces render undo buttons for them. */
export const BASKET_CHANGING_TOOLS = new Set(["basket_add", "basket_fill_from_list", "basket_remove", "basket_clear"]);

/** One line changed by a basket tool, so an interface can offer a one-tap undo. */
export interface BasketChange {
  productId: number;
  title: string;
  /** Units added (positive) or removed (negative). */
  delta: number;
  /** Units of this product in the basket after the change. */
  now: number;
}

/** basketItemsUpdate takes a list; keep each call modest for a 60+ line basket. */
const MUTATION_CHUNK = 25;

function money(n: number | null): string {
  return n === null ? "?" : `€${n.toFixed(2)}`;
}

function basketTotal(b: AhBasket): string | null {
  return b.totalFormatted ?? (b.totalPrice === null ? null : money(b.totalPrice));
}

export function createStoreCapability(cfgDeps: StoreCapabilityDeps): Capability {
  const write = cfgDeps.basketWrite ?? false;
  const storeDeps = (ctx: ToolContext): StoreDeps => ({ db: ctx.db, sessionSecret: cfgDeps.sessionSecret, fetchImpl: cfgDeps.fetchImpl });
  const matcherDeps = (ctx: ToolContext) => ({ db: ctx.db, log: ctx.log, llm: cfgDeps.llm });

  async function requireMember(ctx: ToolContext) {
    const deps = storeDeps(ctx);
    if (!(await tokenSource(deps, ctx.household.id).isMember())) {
      throw new Error("Albert Heijn is not connected; the admin connects it with /store ah in a private chat");
    }
    return buildClient(deps, ctx.household.id);
  }

  /** Titles for basket lines from our product cache (AH's basket only carries ids). */
  async function titlesFor(ctx: ToolContext, ids: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    if (ids.length === 0) return out;
    const rows = await ctx.db
      .select({ productId: productsTable.productId, title: productsTable.title })
      .from(productsTable)
      .where(and(eq(productsTable.store, "ah"), inArray(productsTable.productId, ids.map(String))));
    for (const r of rows) out.set(Number(r.productId), r.title);
    return out;
  }

  const storeStatus = defineTool({
    name: "store_status",
    description: "Check whether the Albert Heijn account is connected. Use before basket actions or when the user asks about connecting the store.",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const status = await accountStatus(ctx.db, ctx.household.id);
      const hint =
        status === "connected"
          ? write
            ? "AH is connected; I can search products and put them in the family's AH basket after a Confirm tap."
            : "AH is connected; I can search products and give one-tap add links."
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
    description: write
      ? "Show what is currently in the family's Albert Heijn basket (the online-order basket a family member checks out)."
      : "Show what is currently on the Albert Heijn shopping list (what a family member would turn into a basket in the AH app).",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const ts = tokenSource(storeDeps(ctx), ctx.household.id);
      if (!(await ts.isMember())) return { connected: false, hint: "AH not connected; admin runs /store ah to connect." };
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      if (write) {
        try {
          const b = await ah.basket();
          const titles = await titlesFor(ctx, b.items.map((i) => i.productId).filter((x): x is number => x !== null));
          return {
            connected: true,
            source: "basket",
            count: b.items.length,
            units: b.quantity,
            total: basketTotal(b),
            items: b.items.map((i) => ({ id: i.productId, qty: i.quantity, name: i.productId === null ? null : (titles.get(i.productId) ?? `product ${i.productId}`) })),
          };
        } catch (err) {
          ctx.log.warn({ err }, "basket read failed; falling back to the shopping list");
        }
      }
      const list = await ah.shoppingList();
      return { connected: true, source: "shopping_list", count: list.items.length, items: list.items.map((i) => ({ qty: i.quantity, name: i.description })) };
    },
  });

  const productSchema = z.object({ id: z.union([z.string(), z.number()]), qty: z.number().int().min(1).max(99).optional() });

  const basketAdd = write
    ? defineTool({
        name: "basket_add",
        description:
          "Put a product (numeric id from store_search) into the family's Albert Heijn basket; qty = how many more units to add. One call per product. The user gets a button naming the product, quantity and price and taps it to apply; afterwards they can remove it with one tap. In your reply list each product with its price.",
        schema: productSchema,
        sideEffect: "shop",
        async handler(args, ctx) {
          const ah = await requireMember(ctx);
          const productId = Number(args.id);
          if (!Number.isInteger(productId) || productId <= 0) throw new Error("product id must be a numeric AH id");
          const qty = args.qty ?? 1;
          const p = await ah.product(String(productId)).catch(() => null);
          if (p) await cacheProducts(ctx.db, [p]).catch(() => {});
          const current = await ah.basket().catch(() => null);
          const existing = current?.items.find((i) => i.productId === productId)?.quantity ?? 0;
          const basket = await ah.basketItemsUpdate([{ productId, quantity: existing + qty }]);
          const nowQty = basket.items.find((i) => i.productId === productId)?.quantity ?? existing + qty;
          const title = p?.title ?? `product ${productId}`;
          const changes: BasketChange[] = [{ productId, title, delta: qty, now: nowQty }];
          return {
            added: title,
            qty,
            price: p ? money(p.price) : null,
            inBasketNow: nowQty,
            basketUnits: basket.quantity,
            basketTotal: basketTotal(basket),
            changes,
          };
        },
      })
    : defineTool({
        name: "basket_add",
        description: "Give a one-tap Albert Heijn link to add a product (by numeric id from store_search) to the AH basket. The user taps it in the AH app to add and check out.",
        schema: productSchema,
        sideEffect: "none",
        async handler(args, ctx) {
          const ah = buildClient(storeDeps(ctx), ctx.household.id);
          const p = await ah.product(String(args.id)).catch(() => null);
          return { title: p ? p.title : String(args.id), price: p ? money(p.price) : null, addLink: productDeepLink(args.id), note: "Tap the link, then add it in the AH app." };
        },
      });

  const basketPlan = defineTool({
    name: "basket_plan",
    description:
      "Dry run: match every open item on the shopping list to an Albert Heijn product and show the picks with prices, the items that need a choice, and the ones not found. Nothing is changed. Show this to the user before basket_fill_from_list.",
    schema: z.object({}),
    sideEffect: "none",
    async handler(_args, ctx) {
      const list = await getActiveList(ctx.db, ctx.household.id);
      const ah = buildClient(storeDeps(ctx), ctx.household.id);
      const plan = await planFill(matcherDeps(ctx), ah, ctx.household.id, list.id);
      return {
        picks: plan.picks.map((p) => ({ item: p.item.nameRaw, productId: p.product.id, product: p.product.title, qty: p.qty, price: money(p.product.price), reason: p.reason })),
        needChoice: plan.choices.map((c) => ({ item: c.item.nameRaw, options: c.candidates.slice(0, 4).map((o) => ({ id: o.id, title: o.title, price: money(o.price) })) })),
        notFound: plan.notFound.map((i) => i.nameRaw),
        estimate: money(plan.picks.reduce((sum, p) => sum + (p.product.price ?? 0) * p.qty, 0)),
      };
    },
  });

  const basketFill = write
    ? defineTool({
        name: "basket_fill_from_list",
        description:
          "Put every confidently matched open shopping-list item into the family's Albert Heijn basket and mark those items in_basket. The user taps one button to apply; afterwards each added line gets a remove button. Items needing a choice or not found are reported back. Use basket_plan first when the user wants to see the picks before applying.",
        schema: z.object({}),
        sideEffect: "shop",
        async handler(_args, ctx) {
          const ah = await requireMember(ctx);
          const list = await getActiveList(ctx.db, ctx.household.id);
          const plan = await planFill(matcherDeps(ctx), ah, ctx.household.id, list.id);
          const res = await executeFill(
            { ...matcherDeps(ctx), setInBasket: async (ids) => void (await setStatus(ctx.db, list.id, ids, "in_basket")) },
            ah,
            ctx.household.id,
            plan,
          );
          const changes: BasketChange[] = res.added.map((a) => ({ productId: a.productId, title: a.product, delta: a.qty, now: a.now }));
          return {
            added: res.added.map((a) => `${a.product} ×${a.qty}${a.price !== null ? ` (${money(a.price)})` : ""}`),
            failed: res.failed.map((f) => `${f.name}: ${f.error}`),
            needChoice: res.choices.map((c) => c.item.nameRaw),
            choices: res.choices.map((c) => ({ item: c.item.nameRaw, options: c.candidates.slice(0, 3).map((o) => ({ id: o.id, title: o.title, price: money(o.price) })) })),
            notFound: res.notFound,
            basketTotal: res.basketTotal,
            changes,
          };
        },
      })
    : defineTool({
        name: "basket_fill_from_list",
        description: "Match every open item on the shopping list to an Albert Heijn product and return a one-tap add link and price for each. The user taps the links in the AH app to build the basket and check out. Items needing a choice or not found are reported back.",
        schema: z.object({}),
        sideEffect: "none",
        async handler(_args, ctx) {
          const list = await getActiveList(ctx.db, ctx.household.id);
          const ah = buildClient(storeDeps(ctx), ctx.household.id);
          const plan = await planFill(matcherDeps(ctx), ah, ctx.household.id, list.id);
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

  const basketRemove = defineTool({
    name: "basket_remove",
    description:
      "Take a product (numeric AH id, see basket_view) out of the family's Albert Heijn basket right away, or lower its quantity by qty.",
    schema: z.object({
      id: z.union([z.string(), z.number()]),
      qty: z.number().int().min(1).max(99).optional().describe("units to remove; omit to remove the whole line"),
    }),
    sideEffect: "none",
    async handler(args, ctx) {
      const ah = await requireMember(ctx);
      const productId = Number(args.id);
      if (!Number.isInteger(productId) || productId <= 0) throw new Error("product id must be a numeric AH id");
      const current = await ah.basket();
      const line = current.items.find((i) => i.productId === productId);
      const titles = await titlesFor(ctx, [productId]);
      const name = titles.get(productId) ?? `product ${productId}`;
      if (!line) return { removed: null, name, note: "not in the basket", basketUnits: current.quantity, basketTotal: basketTotal(current), changes: [] };
      const target = args.qty === undefined ? 0 : Math.max(0, line.quantity - args.qty);
      const basket = await ah.basketItemsUpdate([{ productId, quantity: target }]);
      const changes: BasketChange[] = [{ productId, title: name, delta: target - line.quantity, now: target }];
      return { removed: name, qtyRemoved: line.quantity - target, inBasketNow: target, basketUnits: basket.quantity, basketTotal: basketTotal(basket), changes };
    },
  });

  const basketClear = defineTool({
    name: "basket_clear",
    description:
      "Empty the family's Albert Heijn basket: every line is set to 0 once the user taps the Confirm button. Use when asked to clear or empty the AH basket (the shopping list is a different thing: list_clear).",
    schema: z.object({}),
    sideEffect: "shop",
    async handler(_args, ctx) {
      const ah = await requireMember(ctx);
      const current = await ah.basket();
      const lines = current.items.filter((i) => i.productId !== null && i.kind !== "order");
      const ids = [...new Set(lines.map((i) => i.productId as number))];
      if (ids.length === 0) {
        return { cleared: 0, remaining: current.items.length, basketUnits: current.quantity, basketTotal: basketTotal(current), note: current.items.length ? "only lines already in an open order remain; those cannot be cleared here" : "the basket was already empty", changes: [] };
      }
      const titles = await titlesFor(ctx, ids);
      let basket = current;
      for (let i = 0; i < ids.length; i += MUTATION_CHUNK) {
        basket = await ah.basketItemsUpdate(ids.slice(i, i + MUTATION_CHUNK).map((productId) => ({ productId, quantity: 0 })));
      }
      const changes: BasketChange[] = lines.map((l) => ({ productId: l.productId as number, title: titles.get(l.productId as number) ?? `product ${l.productId}`, delta: -l.quantity, now: 0 }));
      return { cleared: ids.length, remaining: basket.items.length, basketUnits: basket.quantity, basketTotal: basketTotal(basket), changes };
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
    if (status !== "connected") return "Store: Albert Heijn is NOT connected yet. Search works; the admin connects it with /store ah.";
    if (write) {
      return [
        "Store: Albert Heijn is connected. You can search AH (real prices, bonus, previously-bought), read the family's AH basket (basket_view) and change it:",
        "basket_add (one call per product, with qty) and basket_fill_from_list put things in; each produces a button under your message that names the product, quantity and price, and the user taps it to apply. basket_remove takes a product out at once. basket_clear empties the basket after a tap. basket_plan previews the list-to-product matching without changing anything.",
        "When asked to buy or add something, search, pick, call basket_add for every product, and in your reply list each product with quantity and price and the total; say the buttons below apply them. After a confirmed add the user gets remove buttons. You never pay; a family member checks out in the AH app.",
      ].join(" ");
    }
    return "Store: Albert Heijn is connected. You can search AH (real prices, bonus, previously-bought) and read the AH list. AH does not let the bot write the basket directly, so basket_add and basket_fill_from_list return one-tap add links with prices; the user taps them in the AH app to add and check out. Present the links clearly, grouped, with prices. You never pay.";
  }

  return {
    name: "store",
    tools: [storeStatus, storeSearch, storeProduct, basketView, basketAdd, basketPlan, basketFill, ...(write ? [basketRemove, basketClear] : []), purchasesOf] as Capability["tools"],
    promptFragment,
  };
}
