// The guided Albert Heijn login, driven from a private chat with the admin.
// The bot never sees the password: the user logs in on AH's own page, is
// redirected to appie://login-exit?code=..., and pastes that URL back here.

import { AH_AUTHORIZE_URL, accountStatus, connectWithCode, disconnect } from "@shopai/capability-store";
import type { Db } from "@shopai/db";
import type { BotContext } from "./bot.js";

export interface StoreLoginDeps {
  db: Db;
  sessionSecret: string | undefined;
  householdId: () => number;
}

// Admins in the middle of pasting a login code: telegram user id -> true.
const awaitingCode = new Set<number>();

export function isAwaitingCode(userId: number): boolean {
  return awaitingCode.has(userId);
}

export async function handleStoreCommand(ctx: BotContext, deps: StoreLoginDeps): Promise<void> {
  if (ctx.member?.role !== "admin") {
    await ctx.reply("Only an admin can connect the store.");
    return;
  }
  if (ctx.chat?.type !== "private") {
    await ctx.reply("For security, connect the store in a private chat with me: open @" + (ctx.me?.username ?? "the bot") + " and send /store there.");
    return;
  }
  if (!deps.sessionSecret) {
    await ctx.reply("Store login is disabled: SESSION_SECRET is not set on the server. Set it and restart, then try again.");
    return;
  }
  const arg = (ctx.match ?? "").toString().trim();
  if (arg === "logout" || arg === "disconnect") {
    await disconnect(deps.db, deps.householdId());
    awaitingCode.delete(ctx.from!.id);
    await ctx.reply("Albert Heijn disconnected. Your tokens were deleted.");
    return;
  }
  if (arg === "status") {
    const s = await accountStatus(deps.db, deps.householdId());
    await ctx.reply(`Albert Heijn: ${s}.`);
    return;
  }
  awaitingCode.add(ctx.from!.id);
  await ctx.reply(
    [
      "Let's connect Albert Heijn. The bot never sees your password.",
      "",
      "1. Open this link and log in to Albert Heijn:",
      AH_AUTHORIZE_URL,
      "",
      "2. After login the page tries to open the AH app and shows an error or a blank page. That's expected.",
      "3. Copy the full address it tried to open (it starts with appie://login-exit?code=...). On a phone, long-press the link or copy from the address bar.",
      "4. Paste that whole address here as your next message.",
      "",
      "Send /store status to check, or /store logout to cancel.",
    ].join("\n"),
    { link_preview_options: { is_disabled: true } },
  );
}

/** Returns true if the message was consumed as a pasted login code. */
export async function maybeConsumeCode(ctx: BotContext, deps: StoreLoginDeps): Promise<boolean> {
  const uid = ctx.from?.id;
  if (!uid || !awaitingCode.has(uid) || ctx.chat?.type !== "private") return false;
  const text = ctx.message?.text ?? "";
  if (!/code=/u.test(text) && !/^[A-Za-z0-9._-]{16,}$/u.test(text.trim())) {
    // Not a code; let normal handling take over (e.g. they typed /store logout).
    if (text.startsWith("/")) return false;
    await ctx.reply("That doesn't look like the login address. It should contain 'code='. Paste the full appie://login-exit?code=... address, or send /store logout to cancel.");
    return true;
  }
  awaitingCode.delete(uid);
  try {
    if (!deps.sessionSecret) throw new Error("SESSION_SECRET not set");
    await connectWithCode({ db: deps.db, sessionSecret: deps.sessionSecret }, deps.householdId(), text);
    // Delete the message with the code so it does not linger in the chat.
    await ctx.api.deleteMessage(ctx.chat!.id, ctx.message!.message_id).catch(() => {});
    await ctx.reply("✅ Albert Heijn connected. I can now add products to your AH shopping list after you confirm. You still check out yourself in the AH app.");
  } catch (err) {
    await ctx.reply(`Could not connect: ${err instanceof Error ? err.message : "unknown error"}. Run /store to try again.`);
  }
  return true;
}
