import { conversations, eq, type Db, type StoredTurn } from "@shopai/db";

export const MAX_TURNS = 20;

export async function loadTurns(db: Db, chatKey: string): Promise<StoredTurn[]> {
  const rows = await db.select().from(conversations).where(eq(conversations.chatKey, chatKey)).limit(1);
  return rows[0]?.turns ?? [];
}

export async function appendTurns(
  db: Db,
  householdId: number,
  chatKey: string,
  newTurns: StoredTurn[],
): Promise<void> {
  const existing = await loadTurns(db, chatKey);
  const turns = [...existing, ...newTurns].slice(-MAX_TURNS);
  await db
    .insert(conversations)
    .values({ chatKey, householdId, turns, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: conversations.chatKey,
      set: { turns, updatedAt: new Date() },
    });
}

export async function clearTurns(db: Db, chatKey: string): Promise<void> {
  await db.update(conversations).set({ turns: [], summary: null, updatedAt: new Date() }).where(eq(conversations.chatKey, chatKey));
}
