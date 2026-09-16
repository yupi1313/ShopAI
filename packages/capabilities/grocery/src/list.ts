import { and, asc, eq, inArray, listItems, lists, staples, type Db, type ListItem } from "@shopai/db";
import { normalizeName } from "@shopai/core";

export async function getActiveList(db: Db, householdId: number): Promise<{ id: number; name: string }> {
  const found = await db
    .select({ id: lists.id, name: lists.name })
    .from(lists)
    .where(and(eq(lists.householdId, householdId), eq(lists.status, "active")))
    .orderBy(asc(lists.id))
    .limit(1);
  if (found[0]) return found[0];
  const [created] = await db.insert(lists).values({ householdId }).returning({ id: lists.id, name: lists.name });
  if (!created) throw new Error("could not create list");
  return created;
}

export async function getOpenItems(db: Db, listId: number): Promise<ListItem[]> {
  return db
    .select()
    .from(listItems)
    .where(and(eq(listItems.listId, listId), inArray(listItems.status, ["pending", "in_basket"])))
    .orderBy(asc(listItems.id));
}

export interface NewItem {
  name: string;
  qty?: number | null;
  unit?: string | null;
  note?: string | null;
}

export interface AddResult {
  added: Array<{ id: number; name: string }>;
  merged: Array<{ id: number; name: string; qty: number | null; unit: string | null }>;
}

/** Add items; an item already open under the same normalised name is merged (quantities summed when units agree). */
export async function addItems(db: Db, listId: number, memberId: number, items: NewItem[]): Promise<AddResult> {
  const open = await getOpenItems(db, listId);
  const byNorm = new Map(open.map((i) => [i.nameNorm, i]));
  const result: AddResult = { added: [], merged: [] };
  for (const raw of items) {
    const name = raw.name.trim();
    if (!name) continue;
    const norm = normalizeName(name);
    const existing = byNorm.get(norm);
    const unit = raw.unit?.trim() || null;
    if (existing) {
      const oldQty = existing.qty === null ? null : Number(existing.qty);
      const canSum = raw.qty != null && oldQty !== null && (existing.unit ?? null) === unit;
      const newQty = canSum ? oldQty + (raw.qty as number) : raw.qty ?? oldQty;
      const [row] = await db
        .update(listItems)
        .set({
          qty: newQty === null || newQty === undefined ? null : String(newQty),
          unit: unit ?? existing.unit,
          note: raw.note?.trim() || existing.note,
          status: "pending",
          updatedAt: new Date(),
        })
        .where(eq(listItems.id, existing.id))
        .returning({ id: listItems.id, name: listItems.nameRaw, qty: listItems.qty, unit: listItems.unit });
      if (row) result.merged.push({ id: row.id, name: row.name, qty: row.qty === null ? null : Number(row.qty), unit: row.unit });
      continue;
    }
    const [row] = await db
      .insert(listItems)
      .values({
        listId,
        nameRaw: name,
        nameNorm: norm,
        qty: raw.qty == null ? null : String(raw.qty),
        unit,
        note: raw.note?.trim() || null,
        addedBy: memberId,
      })
      .returning({ id: listItems.id, name: listItems.nameRaw });
    if (row) {
      result.added.push(row);
      // Track it so a duplicate later in the same call merges instead of inserting twice.
      byNorm.set(norm, {
        id: row.id,
        listId,
        nameRaw: name,
        nameNorm: norm,
        qty: raw.qty == null ? null : String(raw.qty),
        unit,
        note: raw.note?.trim() || null,
        status: "pending",
        addedBy: memberId,
        productRef: null,
        pickReason: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
  return result;
}

export async function updateItem(
  db: Db,
  listId: number,
  id: number,
  patch: { name?: string; qty?: number | null; unit?: string | null; note?: string | null },
): Promise<ListItem | null> {
  const set: Partial<typeof listItems.$inferInsert> = { updatedAt: new Date() };
  if (patch.name !== undefined) {
    set.nameRaw = patch.name.trim();
    set.nameNorm = normalizeName(patch.name);
  }
  if (patch.qty !== undefined) set.qty = patch.qty === null ? null : String(patch.qty);
  if (patch.unit !== undefined) set.unit = patch.unit?.trim() || null;
  if (patch.note !== undefined) set.note = patch.note?.trim() || null;
  const [row] = await db
    .update(listItems)
    .set(set)
    .where(and(eq(listItems.id, id), eq(listItems.listId, listId)))
    .returning();
  return row ?? null;
}

export async function setStatus(
  db: Db,
  listId: number,
  ids: number[],
  status: "pending" | "in_basket" | "bought" | "removed",
): Promise<ListItem[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(listItems)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(listItems.listId, listId), inArray(listItems.id, ids)))
    .returning();
  return rows;
}

/** Mark everything open as bought; returns the count. Also stamps staples' last_bought_at. */
export async function markAllBought(db: Db, householdId: number, listId: number): Promise<number> {
  const open = await getOpenItems(db, listId);
  if (open.length === 0) return 0;
  await setStatus(db, listId, open.map((i) => i.id), "bought");
  await touchStaples(db, householdId, open.map((i) => i.nameNorm));
  return open.length;
}

export async function touchStaples(db: Db, householdId: number, norms: string[]): Promise<void> {
  if (norms.length === 0) return;
  await db
    .update(staples)
    .set({ lastBoughtAt: new Date() })
    .where(and(eq(staples.householdId, householdId), inArray(staples.nameNorm, norms)));
}

/** Resolve item references the model may give: numeric ids or names. */
export function resolveIds(open: ListItem[], refs: Array<number | string>): { ids: number[]; unknown: string[] } {
  const ids = new Set<number>();
  const unknown: string[] = [];
  for (const ref of refs) {
    if (typeof ref === "number") {
      if (open.some((i) => i.id === ref)) ids.add(ref);
      else unknown.push(String(ref));
      continue;
    }
    const asNum = Number(ref);
    if (Number.isInteger(asNum) && open.some((i) => i.id === asNum)) {
      ids.add(asNum);
      continue;
    }
    const norm = normalizeName(ref);
    const hit = open.find((i) => i.nameNorm === norm) ?? open.find((i) => i.nameNorm.includes(norm) || norm.includes(i.nameNorm));
    if (hit) ids.add(hit.id);
    else unknown.push(ref);
  }
  return { ids: [...ids], unknown };
}
