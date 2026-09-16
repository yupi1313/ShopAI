import { z } from "zod";
import { defineTool, type Capability, type ToolContext } from "@shopai/core";
import { formatQty } from "@shopai/core";
import {
  addItems,
  getActiveList,
  getOpenItems,
  markAllBought,
  resolveIds,
  setStatus,
  touchStaples,
  updateItem,
} from "./list.js";
import { listForPrompt, staplesForPrompt } from "./render.js";
import { listStaples, removeStaple, upsertStaple } from "./staples.js";
import { deleteFact, factsForPrompt, listFacts, setFact } from "./facts.js";

export * from "./list.js";
export * from "./render.js";
export * from "./staples.js";
export * from "./facts.js";

/** Tool names that change the list; interfaces re-render the list after these. */
export const LIST_MUTATING_TOOLS = new Set(["list_add", "list_update", "list_remove", "list_mark_bought", "list_clear"]);

const itemRef = z.union([z.number().int(), z.string().min(1)]).describe("item id (number from the list, shown as #id) or its name");

function itemView(i: { id: number; nameRaw: string; qty: string | null; unit: string | null; note: string | null; status: string }) {
  return { id: i.id, name: i.nameRaw, qty: formatQty(i.qty, i.unit) || null, note: i.note, status: i.status };
}

const listGet = defineTool({
  name: "list_get",
  description: "Get the household's current shopping list (open items with ids). Use when asked what is on the list.",
  schema: z.object({}),
  sideEffect: "none",
  async handler(_args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const items = await getOpenItems(ctx.db, list.id);
    return { count: items.length, items: items.map(itemView) };
  },
});

const listAdd = defineTool({
  name: "list_add",
  description:
    "Add one or more items to the shared shopping list. Normalise each item: name in the user's language (singular product name), numeric qty, short unit (l, ml, kg, g, pcs, pack). If the user gives no quantity, omit qty. Items already on the list are merged.",
  schema: z.object({
    items: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          qty: z.number().positive().optional(),
          unit: z.string().max(20).optional(),
          note: z.string().max(200).optional(),
        }),
      )
      .min(1)
      .max(50),
  }),
  sideEffect: "list",
  async handler(args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const res = await addItems(ctx.db, list.id, ctx.member.id, args.items);
    return res;
  },
});

const listUpdate = defineTool({
  name: "list_update",
  description: "Change quantity, unit, note or name of one item on the list.",
  schema: z.object({
    item: itemRef,
    name: z.string().min(1).max(120).optional(),
    qty: z.number().positive().nullable().optional(),
    unit: z.string().max(20).nullable().optional(),
    note: z.string().max(200).nullable().optional(),
  }),
  sideEffect: "list",
  async handler(args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const open = await getOpenItems(ctx.db, list.id);
    const { ids, unknown } = resolveIds(open, [args.item]);
    const id = ids[0];
    if (id === undefined) return { error: "item not found on the list", unknown };
    const row = await updateItem(ctx.db, list.id, id, { name: args.name, qty: args.qty, unit: args.unit, note: args.note });
    return row ? { updated: itemView(row) } : { error: "update failed" };
  },
});

const listRemove = defineTool({
  name: "list_remove",
  description: "Remove items from the list (they were added by mistake or are no longer needed). Not for 'we bought it': use list_mark_bought for that.",
  schema: z.object({ items: z.array(itemRef).min(1).max(50) }),
  sideEffect: "list",
  async handler(args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const open = await getOpenItems(ctx.db, list.id);
    const { ids, unknown } = resolveIds(open, args.items);
    const rows = await setStatus(ctx.db, list.id, ids, "removed");
    return { removed: rows.map(itemView), unknown };
  },
});

const listMarkBought = defineTool({
  name: "list_mark_bought",
  description: "Mark items as bought / done, removing them from the open list and updating staple history.",
  schema: z.object({ items: z.array(itemRef).min(1).max(100) }),
  sideEffect: "list",
  async handler(args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const open = await getOpenItems(ctx.db, list.id);
    const { ids, unknown } = resolveIds(open, args.items);
    const rows = await setStatus(ctx.db, list.id, ids, "bought");
    await touchStaples(ctx.db, ctx.household.id, rows.map((r) => r.nameNorm));
    return { bought: rows.map(itemView), unknown };
  },
});

const listClear = defineTool({
  name: "list_clear",
  description: "Mark EVERYTHING on the list as bought (the shopping trip is done). Only when the user clearly says the whole list is done.",
  schema: z.object({ confirm: z.literal(true) }),
  sideEffect: "list",
  async handler(_args, ctx) {
    const list = await getActiveList(ctx.db, ctx.household.id);
    const n = await markAllBought(ctx.db, ctx.household.id, list.id);
    return { markedBought: n };
  },
});

const staplesGet = defineTool({
  name: "staples_get",
  description: "List the household's staples: items bought regularly, with cadence and last purchase.",
  schema: z.object({}),
  sideEffect: "none",
  async handler(_args, ctx) {
    const rows = await listStaples(ctx.db, ctx.household.id);
    return rows.map((s) => ({ name: s.nameDisplay, cadenceDays: s.cadenceDays, lastBoughtAt: s.lastBoughtAt?.toISOString() ?? null }));
  },
});

const staplesSet = defineTool({
  name: "staples_set",
  description: "Add or update a staple (something the family buys regularly), optionally with how often in days. Use remove=true to delete it.",
  schema: z.object({
    name: z.string().min(1).max(120),
    cadence_days: z.number().int().positive().max(365).optional(),
    remove: z.boolean().optional(),
  }),
  sideEffect: "list",
  async handler(args, ctx) {
    if (args.remove) {
      const ok = await removeStaple(ctx.db, ctx.household.id, args.name);
      return ok ? { removed: args.name } : { error: "no such staple" };
    }
    const row = await upsertStaple(ctx.db, ctx.household.id, args.name, args.cadence_days);
    return { staple: { name: row.nameDisplay, cadenceDays: row.cadenceDays } };
  },
});

const factsGet = defineTool({
  name: "facts_get",
  description: "Read remembered household facts (allergies, dislikes, preferred brands, household size, store preferences).",
  schema: z.object({}),
  sideEffect: "none",
  async handler(_args, ctx) {
    const rows = await listFacts(ctx.db, ctx.household.id);
    return rows.map((f) => ({ key: f.key, value: f.value }));
  },
});

const rememberFact = defineTool({
  name: "remember_fact",
  description:
    "Remember a durable household fact for future conversations, e.g. key 'allergy_nuts' value 'Masha is allergic to nuts', or 'brand_pasta' value 'Grand Italia'. Use forget=true to delete a fact by key. Do not store one-off requests.",
  schema: z.object({
    key: z.string().min(1).max(80),
    value: z.string().max(500).optional(),
    forget: z.boolean().optional(),
  }),
  sideEffect: "list",
  async handler(args, ctx) {
    if (args.forget) {
      const ok = await deleteFact(ctx.db, ctx.household.id, args.key);
      return ok ? { forgotten: args.key } : { error: "no such fact" };
    }
    if (!args.value) return { error: "value is required unless forget=true" };
    const row = await setFact(ctx.db, ctx.household.id, args.key, args.value, ctx.member.id);
    return { remembered: { key: row.key, value: row.value } };
  },
});

async function promptFragment(ctx: ToolContext): Promise<string> {
  const list = await getActiveList(ctx.db, ctx.household.id);
  const [items, stapleRows, facts] = await Promise.all([
    getOpenItems(ctx.db, list.id),
    listStaples(ctx.db, ctx.household.id),
    listFacts(ctx.db, ctx.household.id),
  ]);
  return [listForPrompt(items), staplesForPrompt(stapleRows), factsForPrompt(facts)].filter(Boolean).join("\n\n");
}

export const groceryCapability: Capability = {
  name: "grocery",
  tools: [listGet, listAdd, listUpdate, listRemove, listMarkBought, listClear, staplesGet, staplesSet, factsGet, rememberFact] as Capability["tools"],
  promptFragment,
};
