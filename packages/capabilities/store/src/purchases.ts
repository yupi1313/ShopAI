// Purchase history: import AH in-store receipts and online orders into the
// purchases / purchase_items tables, and answer "how often / how much" from
// them. Receipt lines carry till abbreviations ("CAMP KWARK") and till ids;
// the ids are mapped to webshop ids and the real titles are filled in from
// the product cache, a few hundred lookups per run so AH is not hammered.

import type { AhClient } from "@shopai/connector-ah";
import { normalizeName, type Logger } from "@shopai/core";
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, or, products as productsTable, purchaseItems, purchases, sqlTag, type Db } from "@shopai/db";
import { cacheProducts } from "./matcher.js";

export interface ImportDeps {
  db: Db;
  log: Logger;
}

export interface ImportResult {
  receiptsSeen: number;
  receiptsImported: number;
  ordersImported: number;
  itemsImported: number;
  titlesResolved: number;
  errors: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const money = (n: number | null) => (n === null ? null : String(n));

async function existingExternalIds(db: Db, householdId: number, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ externalId: purchases.externalId })
    .from(purchases)
    .where(and(eq(purchases.householdId, householdId), eq(purchases.store, "ah"), inArray(purchases.externalId, ids)));
  return new Set(rows.map((r) => r.externalId).filter((x): x is string => x !== null));
}

/**
 * Import everything not yet stored. Walks receipts newest-first and stops at
 * the first page that is fully known (unless `full`), so a routine run costs
 * one or two requests. Gentle pacing: one AH call every ~250 ms.
 */
export async function importPurchases(deps: ImportDeps, ah: AhClient, householdId: number, opts: { full?: boolean; maxTitleLookups?: number } = {}): Promise<ImportResult> {
  const out: ImportResult = { receiptsSeen: 0, receiptsImported: 0, ordersImported: 0, itemsImported: 0, titlesResolved: 0, errors: 0 };
  const log = deps.log.child({ mod: "purchases" });

  // ---- in-store receipts ----
  const pageSize = 50;
  for (let offset = 0; ; offset += pageSize) {
    const page = await ah.receipts(offset, pageSize);
    out.receiptsSeen += page.receipts.length;
    if (page.receipts.length === 0) break;
    const known = await existingExternalIds(deps.db, householdId, page.receipts.map((r) => r.id));
    const fresh = page.receipts.filter((r) => !known.has(r.id));
    for (const summary of fresh) {
      try {
        await sleep(250);
        const receipt = await ah.receipt(summary.id);
        const map = await ah.convertPosIds(receipt.lines.map((l) => l.posId).filter((x): x is number => x !== null));
        const boughtAt = new Date(summary.dateTime);
        await deps.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(purchases)
            .values({ householdId, store: "ah", externalId: summary.id, boughtAt, channel: "store", total: money(summary.total ?? receipt.total) })
            .onConflictDoNothing()
            .returning({ id: purchases.id });
          if (!row) return;
          const lines = receipt.lines.filter((l) => l.name.length > 0);
          if (lines.length === 0) return;
          await tx.insert(purchaseItems).values(
            lines.map((l) => {
              const webshopId = l.posId !== null ? map.get(l.posId) : undefined;
              return {
                purchaseId: row.id,
                nameRaw: l.name || "?",
                nameNorm: normalizeName(l.name || "?"),
                productId: webshopId ? String(webshopId) : null,
                brand: null,
                qty: String(l.weight ? l.weight.amount : l.quantity),
                unit: l.weight ? l.weight.unit || null : null,
                price: money(l.amount ?? (l.unitPrice === null ? null : Math.round(l.unitPrice * l.quantity * 100) / 100)),
              };
            }),
          );
          out.itemsImported += lines.length;
        });
        out.receiptsImported++;
      } catch (err) {
        out.errors++;
        log.warn({ err: err instanceof Error ? err.message : String(err), receipt: summary.id }, "receipt import failed");
      }
    }
    const done = offset + page.receipts.length >= page.total;
    if (done || (fresh.length === 0 && !opts.full)) break;
    await sleep(250);
  }

  // ---- online orders ----
  try {
    const orders = (await ah.orders()).filter((o) => o.completed || /geleverd|bezorgd|geïncasseerd|afgehaald/iu.test(o.status ?? ""));
    const known = await existingExternalIds(deps.db, householdId, orders.map((o) => `order:${o.orderId}`));
    for (const o of orders) {
      if (known.has(`order:${o.orderId}`)) continue;
      try {
        await sleep(250);
        const order = await ah.order(o.orderId);
        const when = o.deliveryDate ? new Date(`${o.deliveryDate}T12:00:00Z`) : o.closingDateTime ? new Date(o.closingDateTime) : new Date();
        await deps.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(purchases)
            .values({ householdId, store: "ah", externalId: `order:${o.orderId}`, boughtAt: when, channel: "online", total: money(o.total) })
            .onConflictDoNothing()
            .returning({ id: purchases.id });
          if (!row) return;
          const lines = order.lines.filter((l) => l.title && l.quantity > 0);
          if (lines.length === 0) return;
          await tx.insert(purchaseItems).values(
            lines.map((l) => ({
              purchaseId: row.id,
              nameRaw: l.title,
              nameNorm: normalizeName(l.title),
              productId: l.webshopId === null ? null : String(l.webshopId),
              brand: l.brand,
              qty: String(l.quantity),
              unit: l.size,
              price: money(l.amount),
            })),
          );
          out.itemsImported += lines.length;
        });
        out.ordersImported++;
      } catch (err) {
        out.errors++;
        log.warn({ err: err instanceof Error ? err.message : String(err), order: o.orderId }, "order import failed");
      }
    }
  } catch (err) {
    out.errors++;
    log.warn({ err: err instanceof Error ? err.message : String(err) }, "order list failed");
  }

  // ---- real titles for till abbreviations ----
  out.titlesResolved = await resolveTitles(deps, ah, householdId, opts.maxTitleLookups ?? 300);
  log.info(out, "purchase import done");
  return out;
}

/**
 * Receipt lines are stored with the till abbreviation. For lines that have a
 * webshop id, fetch the product once (cached in `products`) and rewrite the
 * line name to the real title. Bounded per run.
 */
export async function resolveTitles(deps: ImportDeps, ah: AhClient, householdId: number, max: number): Promise<number> {
  const rows = await deps.db
    .selectDistinct({ productId: purchaseItems.productId })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
    .leftJoin(productsTable, and(eq(productsTable.store, "ah"), eq(productsTable.productId, purchaseItems.productId)))
    .where(and(eq(purchases.householdId, householdId), isNotNull(purchaseItems.productId), or(isNull(productsTable.productId), isNull(productsTable.subcategory))))
    .limit(max);
  let resolved = 0;
  for (const r of rows) {
    if (!r.productId) continue;
    try {
      await sleep(200);
      const p = await ah.product(r.productId);
      if (!p) continue;
      await cacheProducts(deps.db, [p]);
      resolved++;
    } catch (err) {
      deps.log.debug({ err: err instanceof Error ? err.message : String(err), productId: r.productId }, "title lookup failed");
    }
  }
  // Rewrite names for every store line whose product is now cached (also covers earlier runs).
  await deps.db.execute(sqlTag`
    UPDATE purchase_items pi
    SET name_raw = p.title,
        name_norm = lower(regexp_replace(p.title, '[^[:alnum:][:space:]%+-]', ' ', 'g')),
        brand = COALESCE(pi.brand, p.brand)
    FROM purchases pu, products p
    WHERE pi.purchase_id = pu.id
      AND pu.household_id = ${householdId}
      AND pu.channel = 'store'
      AND p.store = 'ah'
      AND p.product_id = pi.product_id
      AND pi.name_raw <> p.title
  `);
  return resolved;
}

// ------------------------------------------------------------------ queries

export interface HistoryMatch {
  productId: string | null;
  title: string;
  brand: string | null;
  /** AH sub-category when known, e.g. "Zwaar bier". */
  category: string | null;
  times: number;
  totalQty: number;
  totalSpent: number;
  lastBought: string;
  firstBought: string;
}

export interface HistoryStats {
  query: string;
  days: number;
  /** Coarse AH category the answer was limited to, when the query named a department. */
  restrictedTo: string | null;
  /** Lines dropped by that restriction (e.g. milk chocolate for "melk"). */
  excluded: number;
  /** Distinct shopping trips/orders in the window (all products). */
  tripsInWindow: number;
  matches: HistoryMatch[];
  /** Trips on which something matching was bought. */
  tripsWithMatch: number;
  totalQty: number;
  totalSpent: number;
  perWeek: number;
  lastBought: string | null;
  recent: Array<{ date: string; title: string; qty: number; price: number | null; channel: string | null }>;
}

/** Everything the family bought matching `query` (name, brand or AH category) in the last `days`. */
export async function purchaseStats(db: Db, householdId: number, query: string, days = 180): Promise<HistoryStats> {
  const since = new Date(Date.now() - days * 86_400_000);
  const q = `%${normalizeName(query)}%`;
  // Pass 1: product name, brand or AH sub-category ("Zwaar bier"). Pass 2, only
  // when that finds nothing: the coarse category ("Bier, wijn, aperitieven"),
  // which would otherwise drag wine into a beer question.
  const select = (where: ReturnType<typeof or>) =>
    db
      .select({
        purchaseId: purchases.id,
        boughtAt: purchases.boughtAt,
        channel: purchases.channel,
        productId: purchaseItems.productId,
        nameRaw: purchaseItems.nameRaw,
        brand: purchaseItems.brand,
        qty: purchaseItems.qty,
        price: purchaseItems.price,
        title: productsTable.title,
        pBrand: productsTable.brand,
        subcategory: productsTable.subcategory,
        category: productsTable.category,
      })
      .from(purchaseItems)
      .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
      .leftJoin(productsTable, and(eq(productsTable.store, "ah"), eq(productsTable.productId, purchaseItems.productId)))
      .where(and(eq(purchases.householdId, householdId), gte(purchases.boughtAt, since), where))
      .orderBy(desc(purchases.boughtAt));
  let rows = await select(or(ilike(purchaseItems.nameNorm, q), ilike(purchaseItems.nameRaw, q), ilike(purchaseItems.brand, q), ilike(productsTable.title, q), ilike(productsTable.brand, q), ilike(productsTable.subcategory, q)));
  if (rows.length === 0) rows = await select(or(ilike(productsTable.category, q)));

  // A word like "melk" also sits in "Melkchocolade" and "Knoppers Melk". When
  // the sub-categories that match the word point clearly at one department
  // ("Houdbare melk" → "Zuivel, eieren"), keep only that department; lines
  // without a known category stay. Brand or product-name queries match no
  // sub-category and are left alone.
  const { restrictedTo, kept, excluded } = restrictToDepartment(rows, normalizeName(query));
  rows = kept;

  const [tripRow] = await db
    .select({ n: sqlTag<number>`count(*)::int` })
    .from(purchases)
    .where(and(eq(purchases.householdId, householdId), gte(purchases.boughtAt, since)));

  const byProduct = new Map<string, HistoryMatch>();
  const trips = new Set<number>();
  let totalQty = 0;
  let totalSpent = 0;
  for (const r of rows) {
    const key = r.productId ?? `name:${r.nameRaw}`;
    const qty = Number(r.qty ?? 1) || 1;
    const spent = Number(r.price ?? 0) || 0;
    const when = r.boughtAt.toISOString().slice(0, 10);
    trips.add(r.purchaseId);
    totalQty += qty;
    totalSpent += spent;
    const m = byProduct.get(key);
    if (m) {
      m.times++;
      m.totalQty += qty;
      m.totalSpent += spent;
      if (when < m.firstBought) m.firstBought = when;
      if (when > m.lastBought) m.lastBought = when;
    } else {
      byProduct.set(key, { productId: r.productId, title: r.title ?? r.nameRaw, brand: r.brand ?? r.pBrand ?? null, category: r.subcategory ?? r.category ?? null, times: 1, totalQty: qty, totalSpent: spent, lastBought: when, firstBought: when });
    }
  }
  const matches = [...byProduct.values()].sort((a, b) => b.times - a.times || b.totalSpent - a.totalSpent);
  const weeks = Math.max(1, days / 7);
  return {
    query,
    days,
    restrictedTo,
    excluded,
    tripsInWindow: tripRow?.n ?? 0,
    matches: matches.slice(0, 12),
    tripsWithMatch: trips.size,
    totalQty: Math.round(totalQty * 100) / 100,
    totalSpent: Math.round(totalSpent * 100) / 100,
    perWeek: Math.round((totalQty / weeks) * 100) / 100,
    lastBought: rows[0]?.boughtAt.toISOString().slice(0, 10) ?? null,
    recent: rows.slice(0, 10).map((r) => ({ date: r.boughtAt.toISOString().slice(0, 10), title: r.title ?? r.nameRaw, qty: Number(r.qty ?? 1) || 1, price: r.price === null ? null : Number(r.price), channel: r.channel })),
  };
}

interface CategorisedRow {
  qty: string | null;
  subcategory: string | null;
  category: string | null;
}

/**
 * Pick the department a query is about from the sub-categories it matches,
 * weighted by units bought, and drop lines from other departments. Requires
 * a clear majority (60 %); otherwise nothing is dropped.
 */
export function restrictToDepartment<T extends CategorisedRow>(rows: T[], qNorm: string): { restrictedTo: string | null; kept: T[]; excluded: number } {
  const weight = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (!r.category || !r.subcategory || !r.subcategory.toLowerCase().includes(qNorm)) continue;
    const w = Number(r.qty ?? 1) || 1;
    weight.set(r.category, (weight.get(r.category) ?? 0) + w);
    total += w;
  }
  if (total === 0) return { restrictedTo: null, kept: rows, excluded: 0 };
  const [top, topWeight] = [...weight.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (topWeight / total < 0.6) return { restrictedTo: null, kept: rows, excluded: 0 };
  const kept = rows.filter((r) => !r.category || r.category === top);
  return { restrictedTo: top, kept, excluded: rows.length - kept.length };
}

export interface RecentPurchase {
  date: string;
  channel: string | null;
  total: number | null;
  items: number;
  sample: string[];
}

/** The last `limit` shopping trips / orders with a few item names each. */
export async function recentPurchases(db: Db, householdId: number, limit = 8): Promise<RecentPurchase[]> {
  const trips = await db
    .select({ id: purchases.id, boughtAt: purchases.boughtAt, channel: purchases.channel, total: purchases.total })
    .from(purchases)
    .where(eq(purchases.householdId, householdId))
    .orderBy(desc(purchases.boughtAt))
    .limit(limit);
  if (trips.length === 0) return [];
  const items = await db
    .select({ purchaseId: purchaseItems.purchaseId, nameRaw: purchaseItems.nameRaw, title: productsTable.title, price: purchaseItems.price })
    .from(purchaseItems)
    .leftJoin(productsTable, and(eq(productsTable.store, "ah"), eq(productsTable.productId, purchaseItems.productId)))
    .where(inArray(purchaseItems.purchaseId, trips.map((t) => t.id)));
  return trips.map((t) => {
    const mine = items.filter((i) => i.purchaseId === t.id).sort((a, b) => Number(b.price ?? 0) - Number(a.price ?? 0));
    return {
      date: t.boughtAt.toISOString().slice(0, 10),
      channel: t.channel,
      total: t.total === null ? null : Number(t.total),
      items: mine.length,
      sample: mine.slice(0, 5).map((i) => i.title ?? i.nameRaw),
    };
  });
}

/** Spend per calendar month, newest first. */
export async function spendingByMonth(db: Db, householdId: number, months = 6): Promise<Array<{ month: string; trips: number; total: number; inStore: number; online: number }>> {
  const rows = await db.execute(sqlTag`
    SELECT to_char(date_trunc('month', bought_at AT TIME ZONE 'Europe/Amsterdam'), 'YYYY-MM') AS month,
           count(*)::int AS trips,
           coalesce(sum(total), 0)::float AS total,
           coalesce(sum(total) FILTER (WHERE channel = 'store'), 0)::float AS in_store,
           coalesce(sum(total) FILTER (WHERE channel = 'online'), 0)::float AS online
    FROM purchases
    WHERE household_id = ${householdId}
    GROUP BY 1
    ORDER BY 1 DESC
    LIMIT ${months}
  `);
  return (rows as unknown as Array<{ month: string; trips: number; total: number; in_store: number; online: number }>).map((r) => ({
    month: r.month,
    trips: r.trips,
    total: Math.round(r.total * 100) / 100,
    inStore: Math.round(r.in_store * 100) / 100,
    online: Math.round(r.online * 100) / 100,
  }));
}

/** Import coverage: how many trips are stored and the date range. */
export async function purchaseCoverage(db: Db, householdId: number): Promise<{ trips: number; items: number; from: string | null; to: string | null }> {
  const [row] = await db
    .select({
      trips: sqlTag<number>`count(*)::int`,
      from: sqlTag<Date | null>`min(bought_at)`,
      to: sqlTag<Date | null>`max(bought_at)`,
    })
    .from(purchases)
    .where(eq(purchases.householdId, householdId));
  const [items] = await db
    .select({ n: sqlTag<number>`count(*)::int` })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
    .where(eq(purchases.householdId, householdId));
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return { trips: row?.trips ?? 0, items: items?.n ?? 0, from: iso(row?.from), to: iso(row?.to) };
}

/**
 * Brand learning for the matcher: the product the family bought most often
 * for a list item name, from receipts and orders (last 365 days).
 */
export async function usualProductFor(db: Db, householdId: number, name: string): Promise<{ productId: string; title: string; times: number } | null> {
  const q = `%${normalizeName(name)}%`;
  const since = new Date(Date.now() - 365 * 86_400_000);
  const rows = await db
    .select({ productId: purchaseItems.productId, title: sqlTag<string | null>`max(${productsTable.title})`, nameRaw: sqlTag<string>`max(${purchaseItems.nameRaw})`, n: sqlTag<number>`count(*)::int` })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
    .leftJoin(productsTable, and(eq(productsTable.store, "ah"), eq(productsTable.productId, purchaseItems.productId)))
    .where(and(eq(purchases.householdId, householdId), gte(purchases.boughtAt, since), isNotNull(purchaseItems.productId), or(ilike(purchaseItems.nameNorm, q), ilike(productsTable.title, q))))
    .groupBy(purchaseItems.productId)
    .orderBy(desc(sqlTag`count(*)`))
    .limit(1);
  const top = rows[0];
  if (!top?.productId || top.n < 2) return null;
  return { productId: top.productId, title: top.title ?? top.nameRaw, times: top.n };
}
