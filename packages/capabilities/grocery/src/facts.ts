import { and, asc, eq, householdFacts, type Db, type HouseholdFact } from "@shopai/db";

export async function listFacts(db: Db, householdId: number): Promise<HouseholdFact[]> {
  return db.select().from(householdFacts).where(eq(householdFacts.householdId, householdId)).orderBy(asc(householdFacts.key));
}

export async function setFact(
  db: Db,
  householdId: number,
  key: string,
  value: string,
  setBy: number | null,
  source: "member" | "inferred" = "member",
): Promise<HouseholdFact> {
  const k = key.trim().toLowerCase().replace(/\s+/gu, "_").slice(0, 80);
  const [row] = await db
    .insert(householdFacts)
    .values({ householdId, key: k, value: value.trim().slice(0, 500), source, setBy, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [householdFacts.householdId, householdFacts.key],
      set: { value: value.trim().slice(0, 500), source, setBy, updatedAt: new Date() },
    })
    .returning();
  if (!row) throw new Error("set fact failed");
  return row;
}

export async function deleteFact(db: Db, householdId: number, key: string): Promise<boolean> {
  const rows = await db
    .delete(householdFacts)
    .where(and(eq(householdFacts.householdId, householdId), eq(householdFacts.key, key.trim().toLowerCase())))
    .returning({ id: householdFacts.id });
  return rows.length > 0;
}

export function factsForPrompt(rows: HouseholdFact[]): string {
  if (rows.length === 0) return "";
  return `Household facts (remembered preferences):\n${rows.slice(0, 40).map((f) => `- ${f.key}: ${f.value}`).join("\n")}`;
}
