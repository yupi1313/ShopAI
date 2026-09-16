import { and, asc, eq, staples, type Db, type Staple } from "@shopai/db";
import { normalizeName } from "@shopai/core";

export async function listStaples(db: Db, householdId: number): Promise<Staple[]> {
  return db.select().from(staples).where(eq(staples.householdId, householdId)).orderBy(asc(staples.nameDisplay));
}

export async function upsertStaple(
  db: Db,
  householdId: number,
  name: string,
  cadenceDays: number | null | undefined,
): Promise<Staple> {
  const nameNorm = normalizeName(name);
  const [row] = await db
    .insert(staples)
    .values({ householdId, nameNorm, nameDisplay: name.trim(), cadenceDays: cadenceDays ?? null })
    .onConflictDoUpdate({
      target: [staples.householdId, staples.nameNorm],
      set: { nameDisplay: name.trim(), ...(cadenceDays !== undefined ? { cadenceDays } : {}) },
    })
    .returning();
  if (!row) throw new Error("upsert staple failed");
  return row;
}

export async function removeStaple(db: Db, householdId: number, name: string): Promise<boolean> {
  const rows = await db
    .delete(staples)
    .where(and(eq(staples.householdId, householdId), eq(staples.nameNorm, normalizeName(name))))
    .returning({ id: staples.id });
  return rows.length > 0;
}
