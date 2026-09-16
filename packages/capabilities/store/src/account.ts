import {
  AhClient,
  anonymousToken,
  exchangeCode,
  extractCode,
  refreshTokens,
  type AhTokens,
  type TokenSource,
} from "@shopai/connector-ah";

export { refreshTokens } from "@shopai/connector-ah";
import { decryptSecret, encryptSecret } from "@shopai/core";
import { and, eq, storeAccounts, type Db } from "@shopai/db";

export interface StoreDeps {
  db: Db;
  sessionSecret: string;
  fetchImpl?: typeof fetch;
}

async function loadTokens(db: Db, householdId: number, secret: string): Promise<AhTokens | null> {
  const rows = await db
    .select()
    .from(storeAccounts)
    .where(and(eq(storeAccounts.householdId, householdId), eq(storeAccounts.store, "ah")))
    .limit(1);
  const row = rows[0];
  if (!row?.encTokens) return null;
  try {
    return JSON.parse(decryptSecret(row.encTokens, secret)) as AhTokens;
  } catch {
    return null;
  }
}

async function saveTokens(db: Db, householdId: number, secret: string, tokens: AhTokens): Promise<void> {
  const enc = encryptSecret(JSON.stringify(tokens), secret);
  await db
    .insert(storeAccounts)
    .values({
      householdId,
      store: "ah",
      encTokens: enc,
      status: "connected",
      connectedAt: new Date(),
      lastError: null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [storeAccounts.householdId, storeAccounts.store],
      set: { encTokens: enc, status: "connected", lastError: null, updatedAt: new Date() },
    });
}

export async function markExpired(db: Db, householdId: number, error: string): Promise<void> {
  await db
    .update(storeAccounts)
    .set({ status: "expired", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(and(eq(storeAccounts.householdId, householdId), eq(storeAccounts.store, "ah")));
}

export async function accountStatus(db: Db, householdId: number): Promise<"disconnected" | "connected" | "expired"> {
  const rows = await db
    .select({ status: storeAccounts.status })
    .from(storeAccounts)
    .where(and(eq(storeAccounts.householdId, householdId), eq(storeAccounts.store, "ah")))
    .limit(1);
  return rows[0]?.status ?? "disconnected";
}

export async function disconnect(db: Db, householdId: number): Promise<void> {
  await db
    .update(storeAccounts)
    .set({ encTokens: null, status: "disconnected", lastError: null, updatedAt: new Date() })
    .where(and(eq(storeAccounts.householdId, householdId), eq(storeAccounts.store, "ah")));
}

/** Complete the guided login: exchange the pasted code and store member tokens. */
export async function connectWithCode(deps: StoreDeps, householdId: number, pasted: string): Promise<void> {
  const code = extractCode(pasted);
  if (!code) throw new Error("no login code found in what you sent");
  const tokens = await exchangeCode(code, deps.fetchImpl);
  await saveTokens(deps.db, householdId, deps.sessionSecret, tokens);
}

/**
 * Connect using a refresh token captured from the AH app's traffic. Validates
 * it by doing one refresh (which also yields an access token), then stores the
 * result. This bypasses the browser OAuth flow entirely.
 */
export async function connectWithRefreshToken(deps: StoreDeps, householdId: number, refreshToken: string): Promise<void> {
  const rt = refreshToken.trim();
  if (rt.length < 12) throw new Error("that does not look like a refresh token");
  const tokens = await refreshTokens(rt, deps.fetchImpl);
  await saveTokens(deps.db, householdId, deps.sessionSecret, tokens);
}

/**
 * TokenSource for the AH client. Uses the member session if connected
 * (refreshing when stale), otherwise a throwaway anonymous token so search
 * and product detail keep working before login.
 */
export function tokenSource(deps: StoreDeps, householdId: number): TokenSource & { isMember(): Promise<boolean> } {
  let cache: AhTokens | null = null;
  let anon: AhTokens | null = null;

  return {
    async isMember() {
      cache ??= await loadTokens(deps.db, householdId, deps.sessionSecret);
      return Boolean(cache?.member);
    },
    async get(): Promise<AhTokens> {
      cache ??= await loadTokens(deps.db, householdId, deps.sessionSecret);
      if (cache?.member) {
        if (cache.expiresAt > Date.now()) return cache;
        try {
          cache = await refreshTokens(cache.refreshToken, deps.fetchImpl);
          await saveTokens(deps.db, householdId, deps.sessionSecret, cache);
          return cache;
        } catch (err) {
          await markExpired(deps.db, householdId, err instanceof Error ? err.message : "refresh failed");
          cache = null;
          // fall through to anonymous so read tools still work
        }
      }
      if (anon && anon.expiresAt > Date.now()) return anon;
      anon = await anonymousToken(deps.fetchImpl);
      return anon;
    },
    async onRefreshed(tokens: AhTokens) {
      cache = tokens;
      await saveTokens(deps.db, householdId, deps.sessionSecret, tokens);
    },
  };
}

export function buildClient(deps: StoreDeps, householdId: number): AhClient {
  return new AhClient(tokenSource(deps, householdId), deps.fetchImpl);
}
