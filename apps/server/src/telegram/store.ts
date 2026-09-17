// Guided store login, driven from a private chat with the admin. Store-aware so
// new stores (bol.com, Amazon) slot in beside Albert Heijn. For AH the bot never
// sees the password: the user logs in on AH's own page, is redirected to
// appie://login-exit?code=..., and pastes that URL back here.

import { AH_AUTHORIZE_URL, accountStatus, connectWithCode, connectWithRefreshToken, disconnect } from "@shopai/capability-store";
import type { Db } from "@shopai/db";
import type { BotContext } from "./bot.js";

interface StoreDef {
  key: string;
  name: string;
  /** Whether a login flow exists yet. */
  connectable: boolean;
  /** Works without any login: the bot reads the public web (search + links). */
  searchable: boolean;
}

// Order = display order in the menu.
export const STORES: StoreDef[] = [
  { key: "ah", name: "Albert Heijn", connectable: true, searchable: true },
  { key: "bol", name: "bol.com", connectable: false, searchable: true },
  { key: "amazon", name: "Amazon.nl", connectable: false, searchable: true },
];

export interface StoreLoginDeps {
  db: Db;
  sessionSecret: string | undefined;
  householdId: () => number;
}

// Admins mid-login: telegram user id -> store key they are connecting.
const awaitingLogin = new Map<number, string>();

function resolveStore(arg: string): StoreDef | undefined {
  const a = arg.toLowerCase();
  return STORES.find((s) => s.key === a || s.name.toLowerCase() === a || s.name.toLowerCase().startsWith(a));
}

async function showMenu(ctx: BotContext, deps: StoreLoginDeps): Promise<void> {
  const lines = ["Stores:"];
  for (const s of STORES) {
    if (s.key === "ah") {
      const st = await accountStatus(deps.db, deps.householdId());
      lines.push(`• ${s.name} — ${st}  (connect: /store ah)`);
    } else if (s.searchable) {
      lines.push(`• ${s.name} — search + links, no login needed (just ask me in chat)`);
    } else {
      lines.push(`• ${s.name} — coming soon`);
    }
  }
  lines.push("", "To connect a store: /store <name>, e.g. /store ah");
  lines.push("Other: /store ah status, /store ah logout");
  lines.push("", "bol.com / Amazon: ask e.g. “find a 2 m USB-C cable on bol and amazon”. Amazon gets a one-tap add-to-cart link; bol gets product links.");
  await ctx.reply(lines.join("\n"));
}

export async function handleStoreCommand(ctx: BotContext, deps: StoreLoginDeps): Promise<void> {
  if (ctx.member?.role !== "admin") {
    await ctx.reply("Only an admin can connect a store.");
    return;
  }
  const parts = (ctx.match ?? "").toString().trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) {
    await showMenu(ctx, deps);
    return;
  }
  const store = resolveStore(parts[0]!);
  if (!store) {
    await ctx.reply(`Unknown store "${parts[0]}". Known: ${STORES.map((s) => s.key).join(", ")}.`);
    return;
  }
  const sub = (parts[1] ?? "").toLowerCase();

  if (!store.connectable) {
    await ctx.reply(
      store.searchable
        ? `${store.name} needs no login: just ask me in chat, e.g. “find a 2 m USB-C cable on ${store.name}”. I search its public pages and give links${store.key === "amazon" ? " plus a one-tap add-to-cart link" : ""}; you add and check out yourself.`
        : `${store.name} is not connectable yet — it's on the roadmap.`,
    );
    return;
  }

  // --- Albert Heijn ---
  if (store.key === "ah") {
    if (ctx.chat?.type !== "private") {
      await ctx.reply(`For security, connect ${store.name} in a private chat with me: open @${ctx.me?.username ?? "the bot"} and send /store ah there.`);
      return;
    }
    if (sub === "logout" || sub === "disconnect") {
      await disconnect(deps.db, deps.householdId());
      awaitingLogin.delete(ctx.from!.id);
      await ctx.reply(`${store.name} disconnected. Your tokens were deleted.`);
      return;
    }
    if (sub === "status") {
      const s = await accountStatus(deps.db, deps.householdId());
      await ctx.reply(`${store.name}: ${s}.`);
      return;
    }
    if (!deps.sessionSecret) {
      await ctx.reply("Store login is disabled: SESSION_SECRET is not set on the server. Set it and restart, then try again.");
      return;
    }
    awaitingLogin.set(ctx.from!.id, "ah");
    await ctx.reply(
      [
        `Let's connect ${store.name}. The bot never sees your password.`,
        "",
        "Two ways — paste whichever you have as your next message:",
        "",
        "A) A login code, if you can get one:",
        AH_AUTHORIZE_URL,
        "…log in, and if it redirects to appie://login-exit?code=… paste that whole address.",
        "",
        "B) A refresh token captured from the AH phone app (the reliable way). Paste the refresh_token value. I'll walk you through capturing it if you need.",
        "",
        "Send /store ah status to check, or /store ah logout to cancel.",
      ].join("\n"),
      { link_preview_options: { is_disabled: true } },
    );
  }
}

/** Returns true if the message was consumed as a pasted login code. */
export async function maybeConsumeCode(ctx: BotContext, deps: StoreLoginDeps): Promise<boolean> {
  const uid = ctx.from?.id;
  if (!uid || !awaitingLogin.has(uid) || ctx.chat?.type !== "private") return false;
  const store = awaitingLogin.get(uid)!;
  const text = ctx.message?.text ?? "";
  if (text.startsWith("/")) return false; // let commands through (e.g. /store ah logout)
  if (!/code=/u.test(text) && !/^[A-Za-z0-9._-]{16,}$/u.test(text.trim())) {
    await ctx.reply("That doesn't look like the login address. It should contain 'code='. Paste the full appie://login-exit?code=... address, or send /store ah logout to cancel.");
    return true;
  }
  awaitingLogin.delete(uid);
  const isCode = /code=/u.test(text) || /appie:\/\//u.test(text);
  try {
    if (store !== "ah") throw new Error(`no login handler for ${store}`);
    if (!deps.sessionSecret) throw new Error("SESSION_SECRET not set");
    const deps2 = { db: deps.db, sessionSecret: deps.sessionSecret };
    if (isCode) await connectWithCode(deps2, deps.householdId(), text);
    else await connectWithRefreshToken(deps2, deps.householdId(), text);
    await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id).catch(() => {});
    await ctx.reply("✅ Albert Heijn connected. I can now add products to your AH shopping list after you confirm. You still check out yourself in the AH app.");
  } catch (err) {
    awaitingLogin.set(uid, "ah"); // stay in login mode so they can retry without re-running the command
    await ctx.reply(`Could not connect: ${err instanceof Error ? err.message : "unknown error"}. Paste the code or refresh token again, or send /store ah logout to stop.`);
  }
  return true;
}
