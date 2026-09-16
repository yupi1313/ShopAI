import { asc, eq, households, members, type Db, type Household, type Member } from "@shopai/db";
import type { AppConfig } from "./config.js";

/** Phase 1 runs a single household. Create it on first boot. */
export async function ensureHousehold(db: Db, cfg: AppConfig): Promise<Household> {
  const existing = await db.select().from(households).orderBy(asc(households.id)).limit(1);
  if (existing[0]) return existing[0];
  const [created] = await db
    .insert(households)
    .values({ name: cfg.HOUSEHOLD_NAME, timezone: cfg.TZ, settings: { nicknames: cfg.nicknames } })
    .returning();
  if (!created) throw new Error("could not create household");
  return created;
}

export async function ensureAdmin(db: Db, household: Household, telegramUserId: number): Promise<Member> {
  const existing = await db.select().from(members).where(eq(members.telegramUserId, telegramUserId)).limit(1);
  if (existing[0]) {
    if (existing[0].role !== "admin") {
      const [upd] = await db.update(members).set({ role: "admin" }).where(eq(members.id, existing[0].id)).returning();
      return upd ?? existing[0];
    }
    return existing[0];
  }
  const [created] = await db
    .insert(members)
    .values({ householdId: household.id, telegramUserId, displayName: "Admin", role: "admin" })
    .returning();
  if (!created) throw new Error("could not create admin member");
  return created;
}

export async function reloadHousehold(db: Db, id: number): Promise<Household> {
  const rows = await db.select().from(households).where(eq(households.id, id)).limit(1);
  if (!rows[0]) throw new Error("household vanished");
  return rows[0];
}
