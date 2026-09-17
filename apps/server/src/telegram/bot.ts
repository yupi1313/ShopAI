import { Bot, GrammyError, HttpError, type Context } from "grammy";
import {
  and,
  chats,
  eq,
  inArray,
  llmCalls,
  members,
  households,
  pendingActions,
  products,
  sqlTag,
  type Db,
  type Household,
  type Member,
} from "@shopai/db";
import { addressesBot, clearTurns, escapeHtml, type Agent, type ToolContext } from "@shopai/core";
import { buildClient, type BasketChange } from "@shopai/capability-store";
import {
  LIST_MUTATING_TOOLS,
  getActiveList,
  getOpenItems,
  listAsHtml,
  listStaples,
  markAllBought,
  setStatus,
  touchStaples,
} from "@shopai/capability-grocery";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import type { AppConfig } from "./../config.js";
import type { AppLogger } from "./../logger.js";
import { pickLang, t, type Lang } from "./../i18n.js";
import { listKeyboard } from "./keyboard.js";
import { reloadHousehold } from "./../bootstrap.js";
import { handleStoreCommand, maybeConsumeCode, type StoreLoginDeps } from "./store.js";

export type BotContext = Context & {
  member?: Member;
  lang: Lang;
};

export interface BotDeps {
  cfg: AppConfig;
  db: Db;
  log: AppLogger;
  agent: Agent | null;
  household: Household;
}

const REFUSAL_COOLDOWN_MS = 60 * 60 * 1000;

/** Callback data of buttons that only carry text. */
const NOOP = "noop";
/** The bottom row of a basket keyboard: shows the running basket total. */
const STATUS_CB = "noop:status";

export function createBot(deps: BotDeps): Bot<BotContext> {
  const { cfg, db, log } = deps;
  let household = deps.household;
  const bot = new Bot<BotContext>(cfg.TELEGRAM_BOT_TOKEN);
  const refusedAt = new Map<number, number>();
  const chatLocks = new Map<string, Promise<void>>();

  const chatKeyOf = (chatId: number) => `tg:${chatId}`;
  const nicknames = () => household.settings.nicknames ?? cfg.nicknames;
  const storeLoginDeps: StoreLoginDeps = { db, sessionSecret: cfg.SESSION_SECRET, householdId: () => household.id };

  async function refreshHousehold(): Promise<Household> {
    household = await reloadHousehold(db, household.id);
    return household;
  }

  // ---- middleware: language, member resolution, chat registration ----
  bot.use(async (ctx, next) => {
    ctx.lang = pickLang(ctx.from?.language_code);
    if (!ctx.from) return; // channel posts etc.
    const rows = await db.select().from(members).where(eq(members.telegramUserId, ctx.from.id)).limit(1);
    const member = rows[0];
    if (member) {
      ctx.member = member;
      if (member.language) ctx.lang = pickLang(member.language);
      // First real contact: replace the placeholder name and remember the language.
      if (member.displayName === "Admin" || !member.language) {
        const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ").trim() || member.displayName;
        const [upd] = await db
          .update(members)
          .set({ displayName: member.displayName === "Admin" ? name : member.displayName, language: member.language ?? ctx.from.language_code ?? null })
          .where(eq(members.id, member.id))
          .returning();
        if (upd) ctx.member = upd;
      }
      if (ctx.chat) {
        await db
          .insert(chats)
          .values({
            telegramChatId: ctx.chat.id,
            householdId: household.id,
            kind: ctx.chat.type === "channel" ? "group" : ctx.chat.type,
            title: ctx.chat.type === "private" ? null : (ctx.chat.title ?? null),
          })
          .onConflictDoUpdate({ target: chats.telegramChatId, set: { title: ctx.chat.type === "private" ? null : (ctx.chat.title ?? null) } });
      }
      return next();
    }

    // Unknown user.
    const isPrivate = ctx.chat?.type === "private";
    const text = ctx.message?.text ?? "";
    const addressed = isPrivate || (text ? addressesBot(text, bot.botInfo.username, nicknames()) || Boolean(ctx.message?.reply_to_message?.from?.id === bot.botInfo.id) : false);
    if (!addressed && !ctx.callbackQuery) return;
    const last = refusedAt.get(ctx.from.id) ?? 0;
    if (Date.now() - last < REFUSAL_COOLDOWN_MS) return;
    refusedAt.set(ctx.from.id, Date.now());
    log.warn({ userId: ctx.from.id, username: ctx.from.username, chatId: ctx.chat?.id }, "unknown user addressed the bot");
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "⛔", show_alert: false }).catch(() => {});
      return;
    }
    await ctx.reply(t(ctx.lang).notAuthorised(ctx.from.id)).catch(() => {});
    if (!cfg.ADMIN_TELEGRAM_ID || cfg.ADMIN_TELEGRAM_ID === ctx.from.id) return;
    const who = `${[ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ")}${ctx.from.username ? ` @${ctx.from.username}` : ""}`;
    await bot.api
      .sendMessage(cfg.ADMIN_TELEGRAM_ID, `Unknown user tried to talk to the bot: ${who} (id ${ctx.from.id}) in chat ${ctx.chat?.id}. Add with /members add ${ctx.from.id} Name`)
      .catch(() => {});
  });

  // ---- helpers ----
  async function renderList(ctx: BotContext, mode: "send" | "edit"): Promise<void> {
    const s = t(ctx.lang);
    const list = await getActiveList(db, household.id);
    const items = await getOpenItems(db, list.id);
    const html = listAsHtml(items, s.listTitle);
    const kb = listKeyboard(items, s);
    if (mode === "edit" && ctx.callbackQuery?.message) {
      try {
        await ctx.editMessageText(html, { parse_mode: "HTML", reply_markup: kb });
        return;
      } catch (err) {
        // "message is not modified" is fine; anything else falls back to a new message.
        if (err instanceof GrammyError && /not modified/u.test(err.description)) return;
      }
    }
    await ctx.reply(html, { parse_mode: "HTML", reply_markup: kb });
  }

  function isAdmin(ctx: BotContext): boolean {
    return ctx.member?.role === "admin";
  }

  function toolCtx(ctx: BotContext): ToolContext {
    if (!ctx.member || !ctx.chat) throw new Error("no member/chat in context");
    return {
      db,
      log,
      household,
      member: ctx.member,
      chatKey: chatKeyOf(ctx.chat.id),
      chatKind: ctx.chat.type === "channel" ? "group" : ctx.chat.type,
      now: new Date(),
    };
  }

  function withChatLock<T>(key: string, fn: () => Promise<T>): { started: boolean; result: Promise<T | undefined> } {
    const prev = chatLocks.get(key);
    if (prev) {
      // Queue behind the running agent turn rather than running two at once.
      const chained = prev.then(fn, fn);
      chatLocks.set(key, chained.then(() => undefined, () => undefined));
      return { started: false, result: chained };
    }
    const run = fn();
    chatLocks.set(key, run.then(() => undefined, () => undefined));
    void run.finally(() => {
      if (chatLocks.get(key) === undefined) return;
    });
    return { started: true, result: run };
  }

  // ---- commands ----
  bot.command("start", async (ctx) => {
    await ctx.reply(t(ctx.lang).welcome);
    await renderList(ctx, "send");
  });
  bot.command("help", (ctx) => ctx.reply(t(ctx.lang).help));
  bot.command("id", (ctx) => ctx.reply(t(ctx.lang).yourId(ctx.from?.id ?? 0, ctx.chat.id)));
  bot.command("list", (ctx) => renderList(ctx, "send"));
  bot.command("done", async (ctx) => {
    const list = await getActiveList(db, household.id);
    const n = await markAllBought(db, household.id, list.id);
    await ctx.reply(t(ctx.lang).allDone(n));
  });
  bot.command("reset", async (ctx) => {
    await clearTurns(db, chatKeyOf(ctx.chat.id));
    await ctx.reply(t(ctx.lang).resetDone);
  });
  bot.command("store", (ctx) => handleStoreCommand(ctx, storeLoginDeps));

  bot.command("staples", async (ctx) => {
    const s = t(ctx.lang);
    const rows = await listStaples(db, household.id);
    if (rows.length === 0) return ctx.reply(s.staplesEmpty);
    const lines = rows.map((r) => {
      const cad = r.cadenceDays ? ` — ~${r.cadenceDays} d` : "";
      const last = r.lastBoughtAt ? ` (last ${r.lastBoughtAt.toISOString().slice(0, 10)})` : "";
      return `• ${escapeHtml(r.nameDisplay)}${cad}${last}`;
    });
    return ctx.reply(`<b>${s.staplesTitle}</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML" });
  });

  bot.command("members", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(t(ctx.lang).adminOnly);
    const [, sub, idStr, ...nameParts] = (ctx.match ?? "").trim().split(/\s+/u).length
      ? ["", ...(ctx.match ?? "").trim().split(/\s+/u)]
      : ["", ""];
    if (sub === "add" && idStr) {
      const id = Number(idStr);
      if (!Number.isInteger(id) || id <= 0) return ctx.reply("Usage: /members add <telegram_id> [name]");
      const name = nameParts.join(" ").trim() || `Member ${id}`;
      await db
        .insert(members)
        .values({ householdId: household.id, telegramUserId: id, displayName: name, role: "member" })
        .onConflictDoUpdate({ target: members.telegramUserId, set: { displayName: name } });
      return ctx.reply(`Added ${name} (${id}).`);
    }
    if (sub === "remove" && idStr) {
      const id = Number(idStr);
      if (id === cfg.ADMIN_TELEGRAM_ID) return ctx.reply("Cannot remove the primary admin.");
      const rows = await db.delete(members).where(and(eq(members.telegramUserId, id), eq(members.householdId, household.id))).returning({ id: members.id });
      return ctx.reply(rows.length ? `Removed ${id}.` : `No member with id ${id}.`);
    }
    const rows = await db.select().from(members).where(eq(members.householdId, household.id));
    const lines = rows.map((m) => `• ${escapeHtml(m.displayName)} — <code>${m.telegramUserId}</code>${m.role === "admin" ? " (admin)" : ""}`);
    return ctx.reply(`<b>Members</b>\n${lines.join("\n")}\n\n/members add &lt;id&gt; [name]\n/members remove &lt;id&gt;`, { parse_mode: "HTML" });
  });

  bot.command("nicknames", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(t(ctx.lang).adminOnly);
    const parts = (ctx.match ?? "").trim().split(/\s+/u).filter(Boolean);
    const [sub, ...rest] = parts;
    const current = nicknames();
    if ((sub === "add" || sub === "remove") && rest.length) {
      const word = rest.join(" ").toLowerCase();
      const next = sub === "add" ? [...new Set([...current, word])] : current.filter((n) => n.toLowerCase() !== word);
      await db.update(households).set({ settings: { ...household.settings, nicknames: next } }).where(eq(households.id, household.id));
      await refreshHousehold();
      return ctx.reply(`Nicknames: ${next.join(", ")}`);
    }
    return ctx.reply(`Nicknames: ${current.join(", ")}\n\n/nicknames add <word>\n/nicknames remove <word>`);
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply(t(ctx.lang).adminOnly);
    const [row] = await db
      .select({
        calls: sqlTag<number>`count(*)::int`,
        errors: sqlTag<number>`count(*) filter (where error is not null)::int`,
        prompt: sqlTag<number>`coalesce(sum(prompt_tokens),0)::int`,
        completion: sqlTag<number>`coalesce(sum(completion_tokens),0)::int`,
        reasoning: sqlTag<number>`coalesce(sum(reasoning_tokens),0)::int`,
        p50: sqlTag<number>`coalesce(percentile_cont(0.5) within group (order by latency_ms),0)::int`,
      })
      .from(llmCalls)
      .where(sqlTag`created_at > now() - interval '24 hours'`);
    if (!row) return ctx.reply("no data");
    return ctx.reply(
      [
        `LLM last 24h: ${row.calls} calls, ${row.errors} errors`,
        `tokens: prompt ${row.prompt}, completion ${row.completion} (reasoning ${row.reasoning})`,
        `latency p50: ${row.p50} ms`,
        `model: ${deps.agent ? "configured" : "NOT configured"}`,
      ].join("\n"),
    );
  });

  // ---- callback buttons ----
  bot.callbackQuery(/^li:(b|r|u):(\d+)$/u, async (ctx) => {
    const action = ctx.match[1];
    const id = Number(ctx.match[2]);
    const s = t(ctx.lang);
    const list = await getActiveList(db, household.id);
    const status = action === "b" ? "bought" : action === "r" ? "removed" : "pending";
    const rows = await setStatus(db, list.id, [id], status);
    const row = rows[0];
    if (row && status === "bought") await touchStaples(db, household.id, [row.nameNorm]);
    await ctx.answerCallbackQuery({ text: row ? (status === "bought" ? s.markedBought(row.nameRaw) : s.removed(row.nameRaw)) : "—" }).catch(() => {});
    await renderList(ctx, "edit");
  });
  bot.callbackQuery("list:refresh", async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
    await renderList(ctx, "edit");
  });
  bot.callbackQuery("list:done", async (ctx) => {
    const list = await getActiveList(db, household.id);
    const n = await markAllBought(db, household.id, list.id);
    await ctx.answerCallbackQuery({ text: t(ctx.lang).allDone(n) }).catch(() => {});
    await renderList(ctx, "edit");
  });

  // ---- basket buttons ----
  // Every tap edits the tapped message's keyboard IN PLACE and answers with a
  // toast; nothing new is sent, so the chat never scrolls while the family
  // works down a list of products. A product block is: title rows, an info
  // row ("✔ In basket ×2 — €6.65 (€13.30)") and an action row (➕ / ➖ / ✖);
  // it keeps that shape across states, so the buttons below never move.

  bot.callbackQuery(/^noop(?::.*)?$/u, async (ctx) => {
    await ctx.answerCallbackQuery().catch(() => {});
  });

  /** Confirm all still-pending products of this message in one tap. */
  bot.callbackQuery("pa:all", async (ctx) => {
    if (!ctx.member || !deps.agent) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    let rows = currentRows(ctx);
    const ids = [...new Set(rows.flatMap((row) => row.map(cbOf)).filter((cb): cb is string => cb !== null && cb.startsWith("pa:c:")).map((cb) => cb.slice(5)))];
    let added = 0;
    let total: string | null = null;
    for (const id of ids) {
      try {
        const res = await deps.agent.confirmPending(id, toolCtx(ctx));
        const r = (res.result ?? {}) as Record<string, unknown>;
        const change = Array.isArray(r.changes) ? (r.changes as BasketChange[])[0] : undefined;
        if (res.ok && change) {
          added++;
          total = typeof r.basketTotal === "string" ? r.basketTotal : total;
          rows = rewriteRows(rows, blockOfPending(id), blockRows("in", { qty: change.delta, unit: change.price ?? null, pid: change.productId }), `noop:p:${change.productId}`, total);
        } else {
          rows = rewriteRows(rows, blockOfPending(id), blockRows("failed", { ...infoOf(rows, blockOfPending(id)), reason: res.reason ?? "failed" }), NOOP, total);
        }
      } catch (err) {
        log.error({ err, id }, "add-all: confirm failed");
      }
    }
    rows = rows.map((row) => (row.some((b) => cbOf(b) === "pa:all") ? [{ text: added ? `✔ Added ${added}` : "✔ Nothing left to add", callback_data: NOOP }] : row));
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } }).catch(() => {});
    await ctx.answerCallbackQuery({ text: `Added ${added} product${added === 1 ? "" : "s"}${total ? `. Basket ${total}` : ""}` }).catch(() => {});
  });

  // One queued product: c = confirm, x = skip, m = one more, l = one less.
  bot.callbackQuery(/^pa:(c|x|m|l):(.+)$/u, async (ctx) => {
    if (!ctx.member || !deps.agent) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const kind = ctx.match[1];
    const id = ctx.match[2]!;
    const mine = blockOfPending(id);
    const rows = currentRows(ctx);
    const info = infoOf(rows, mine);

    if (kind === "m" || kind === "l") {
      const args = await pendingArgs(id);
      if (!args) {
        await ctx.answerCallbackQuery({ text: "Already handled" }).catch(() => {});
        return;
      }
      const qty = Math.max(1, Math.min(99, info.qty + (kind === "m" ? 1 : -1)));
      await db.update(pendingActions).set({ args: { ...args, qty } }).where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")));
      await edit(ctx, rewriteRows(rows, mine, blockRows("pending", { qty, unit: info.unit, pendingId: id }), `pa:c:${id}`));
      await ctx.answerCallbackQuery({ text: `×${qty}` }).catch(() => {});
      return;
    }

    if (kind === "x") {
      const cancelled = await deps.agent.cancelPending(id);
      const args = await pendingArgs(id);
      const pid = Number(args?.id);
      await edit(ctx, rewriteRows(rows, mine, blockRows("skipped", { ...info, pid: Number.isInteger(pid) && pid > 0 ? pid : undefined }), NOOP));
      await ctx.answerCallbackQuery({ text: cancelled ? "Skipped" : "Already handled" }).catch(() => {});
      return;
    }

    try {
      const res = await deps.agent.confirmPending(id, toolCtx(ctx));
      const r = (res.result ?? {}) as Record<string, unknown>;
      const total = typeof r.basketTotal === "string" ? r.basketTotal : null;
      const change = Array.isArray(r.changes) ? (r.changes as BasketChange[])[0] : undefined;
      if (!res.ok) {
        await edit(ctx, rewriteRows(rows, mine, blockRows("failed", { ...info, reason: res.reason ?? "failed" }), NOOP));
        await ctx.answerCallbackQuery({ text: `Could not do it: ${res.reason ?? "action failed"}` }).catch(() => {});
        return;
      }
      if (res.tool === "basket_add" && change) {
        await edit(ctx, rewriteRows(rows, mine, blockRows("in", { qty: change.delta, unit: change.price ?? null, pid: change.productId }), `noop:p:${change.productId}`, total));
        await ctx.answerCallbackQuery({ text: `Added ×${change.delta}${total ? `. Basket ${total}` : ""}` }).catch(() => {});
        return;
      }
      // Fill / clear: one tap, one result message with per-line buttons.
      await edit(ctx, rewriteRows(rows, mine, blockRows("done", info), NOOP, total));
      await ctx.answerCallbackQuery({ text: "Done" }).catch(() => {});
      const kb = removeKeyboard(res.result);
      await ctx.reply(`✅ ${summariseShopResult(res.tool, res.result) || "Done."}`, kb ? { reply_markup: kb } : {});
      if (res.tool === "basket_fill_from_list") await renderList(ctx, "send");
    } catch (err) {
      log.error({ err, id }, "confirm failed");
      await ctx.answerCallbackQuery({ text: "Something went wrong. Try again." }).catch(() => {});
    }
  });

  // A product already handled: a = add n more units, x = take n units out.
  bot.callbackQuery(/^bk:(x|a):(\d+):(\d+)$/u, async (ctx) => {
    if (!ctx.member || !cfg.SESSION_SECRET) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const kind = ctx.match[1];
    const pid = Number(ctx.match[2]);
    const n = Number(ctx.match[3]);
    const mine = blockOfProduct(pid);
    const rows = currentRows(ctx);
    const info = infoOf(rows, mine);
    try {
      const ah = buildClient({ db, sessionSecret: cfg.SESSION_SECRET }, household.id);
      const current = await ah.basket();
      const have = current.items.find((i) => i.productId === pid)?.quantity ?? 0;
      const target = kind === "x" ? Math.max(0, have - n) : have + n;
      const basket = target === have ? current : await ah.basketItemsUpdate([{ productId: pid, quantity: target }]);
      const total = basket.totalFormatted ?? (basket.totalPrice === null ? null : `€${basket.totalPrice.toFixed(2)}`);
      // The block tracks what this conversation put in: its own quantity, not the whole basket line.
      const qty = kind === "x" ? Math.max(0, info.qty - n) : (info.state === "in" ? info.qty : 0) + n;
      const next = qty > 0 ? blockRows("in", { qty, unit: info.unit, pid }) : blockRows("removed", { qty: info.qty, unit: info.unit, pid });
      await edit(ctx, rewriteRows(rows, mine, next, `noop:p:${pid}`, total));
      const verb = kind === "x" ? `Removed ×${have - target}` : `Added ×${n}`;
      await ctx.answerCallbackQuery({ text: `${verb}${total ? `. Basket ${total}` : ""}` }).catch(() => {});
    } catch (err) {
      log.error({ err, pid, kind }, "basket button failed");
      await ctx.answerCallbackQuery({ text: "Could not change the basket. Try again." }).catch(() => {});
    }
  });

  async function pendingArgs(id: string): Promise<Record<string, unknown> | null> {
    const rows = await db.select({ args: pendingActions.args }).from(pendingActions).where(eq(pendingActions.id, id)).limit(1);
    return rows[0]?.args ?? null;
  }

  function currentRows(ctx: BotContext): KeyboardRow[] {
    const msg = ctx.callbackQuery?.message;
    return msg && "reply_markup" in msg ? (msg.reply_markup?.inline_keyboard ?? []) : [];
  }

  async function edit(ctx: BotContext, rows: KeyboardRow[]): Promise<void> {
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: rows } }).catch(() => {});
  }

  // ---- free text -> agent ----
  bot.on("message:text", async (ctx) => {
    if (!ctx.member) return;
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;
    // A pasted AH login code in a private chat is consumed before the agent.
    if (await maybeConsumeCode(ctx, storeLoginDeps)) return;
    const isPrivate = ctx.chat.type === "private";
    if (!isPrivate) {
      const replyToBot = ctx.message.reply_to_message?.from?.id === bot.botInfo.id;
      if (!replyToBot && !addressesBot(text, bot.botInfo.username, nicknames())) return;
    }
    if (!deps.agent) {
      await ctx.reply(t(ctx.lang).modelDown);
      return;
    }
    const agent = deps.agent;
    const key = chatKeyOf(ctx.chat.id);

    const { started, result } = withChatLock(key, async () => {
      const typing = setInterval(() => void ctx.replyWithChatAction("typing").catch(() => {}), 4000);
      void ctx.replyWithChatAction("typing").catch(() => {});
      try {
        const out = await agent.run({ ctx: toolCtx(ctx), userText: text });
        const replyOpts = isPrivate ? {} : { reply_parameters: { message_id: ctx.message.message_id } };
        const chunks = chunkText(out.text, 4000);
        const pendingKb = await pendingKeyboard(db, out.pending);
        for (let i = 0; i < chunks.length; i++) {
          const lastChunk = i === chunks.length - 1;
          const kb = lastChunk ? pendingKb : undefined;
          await ctx.reply(chunks[i]!, { ...replyOpts, ...(kb ? { reply_markup: kb } : {}) });
        }
        if (out.pending.length === 0 && out.toolsUsed.some((n) => LIST_MUTATING_TOOLS.has(n))) {
          await renderList(ctx, "send");
        }
        log.info({ chatKey: key, tools: out.toolsUsed, rounds: out.rounds }, "agent turn done");
      } finally {
        clearInterval(typing);
      }
    });
    if (!started) await ctx.reply(t(ctx.lang).busy).catch(() => {});
    await result.catch((err) => {
      log.error({ err, chatKey: key }, "agent turn failed");
      return ctx.reply(t(ctx.lang).modelDown).catch(() => {});
    });
  });

  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) log.error({ description: e.description, method: e.method }, "telegram api error");
    else if (e instanceof HttpError) log.error({ err: e }, "telegram http error");
    else log.error({ err: e }, "bot handler error");
  });

  return bot;
}

export const BOT_COMMANDS = [
  { command: "list", description: "Show the shopping list" },
  { command: "done", description: "Everything bought" },
  { command: "staples", description: "Regular purchases" },
  { command: "store", description: "Connect a store, e.g. /store ah (admin, private chat)" },
  { command: "help", description: "How to use me" },
  { command: "reset", description: "Forget the conversation context" },
  { command: "id", description: "Show my Telegram id" },
];

/** Titles and prices from the product cache (store_search fills it before any basket_add). */
async function productTitles(db: Db, ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ productId: products.productId, title: products.title, price: products.price })
    .from(products)
    .where(and(eq(products.store, "ah"), inArray(products.productId, ids.map(String))));
  for (const r of rows) out.set(Number(r.productId), r.title);
  return out;
}

async function productPrices(db: Db, ids: number[]): Promise<Map<number, number | null>> {
  const out = new Map<number, number | null>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ productId: products.productId, price: products.price })
    .from(products)
    .where(and(eq(products.store, "ah"), inArray(products.productId, ids.map(String))));
  for (const r of rows) out.set(Number(r.productId), r.price === null ? null : Number(r.price));
  return out;
}

/**
 * Telegram never wraps button text: a full-width button on a phone shows
 * about 36 characters, then truncates. So a long title is spread over as many
 * full-width rows as it needs, every row carrying the same callback (tapping
 * any of them is the same action).
 */
const ROW_CHARS = 34;

function wrapLabel(text: string, max = ROW_CHARS): string[] {
  const words = text.replace(/\s+/gu, " ").trim().split(" ");
  const rows: string[] = [];
  let cur = "";
  for (const w of words) {
    const word = w.length > max ? `${w.slice(0, max - 1)}…` : w;
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= max) cur = `${cur} ${word}`;
    else {
      rows.push(cur);
      cur = word;
    }
  }
  if (cur) rows.push(cur);
  return rows.length ? rows : [text];
}

type Btn = { text: string; callback_data: string };
type KeyboardRow = InlineKeyboardButton[];
type BlockState = "pending" | "in" | "removed" | "skipped" | "failed" | "done";

function money(n: number): string {
  return `€${n.toFixed(2)}`;
}

/** "×2 — €6.65 (€13.30)": the part of the info row that survives every state change. */
function formatTail(qty: number, unit: number | null): string {
  if (unit === null) return `×${qty}`;
  return `×${qty} — ${money(unit)}${qty > 1 ? ` (${money(unit * qty)})` : ""}`;
}

function cbOf(b: InlineKeyboardButton): string | null {
  return "callback_data" in b ? b.callback_data : null;
}

/** Rows of one queued product: pa:<c|x|m|l>:<pendingId>. */
function blockOfPending(id: string): (cb: string) => boolean {
  return (cb) => /^pa:[cxml]:/u.test(cb) && cb.slice(5) === id;
}

/** Rows of one handled product: noop:p:<pid> on the inert rows, bk:<a|x>:<pid>:<n> on the buttons. */
function blockOfProduct(pid: number): (cb: string) => boolean {
  return (cb) => cb === `noop:p:${pid}` || (cb.startsWith("bk:") && cb.split(":")[2] === String(pid));
}

/** Quantity, unit price and state of a block, read back from its info row. */
function infoOf(rows: KeyboardRow[], matches: (cb: string) => boolean): { qty: number; unit: number | null; state: BlockState } {
  const hit = rows.filter((row) => row.some((b) => matches(cbOf(b) ?? "")));
  const infoRow = hit[hit.length - 2] ?? hit[hit.length - 1];
  const text = infoRow?.[0]?.text ?? "";
  const q = text.match(/×(\d+)/u);
  const e = text.match(/€\s?(\d+(?:[.,]\d+)?)/u);
  const state: BlockState = /^✔ In basket/u.test(text) ? "in" : /^🚫/u.test(text) ? "removed" : /^⏭/u.test(text) ? "skipped" : /^⚠/u.test(text) ? "failed" : /^✔ Done/u.test(text) ? "done" : "pending";
  return { qty: q ? Math.max(1, Number(q[1])) : 1, unit: e ? Number(e[1]!.replace(",", ".")) : null, state };
}

/** The two bottom rows of a product block (info row + action row) for a state. */
function blockRows(state: BlockState, o: { qty: number; unit: number | null; pid?: number; pendingId?: string; reason?: string }): Btn[][] {
  const tail = formatTail(o.qty, o.unit);
  const pid = o.pid;
  switch (state) {
    case "pending": {
      const id = o.pendingId ?? "";
      const actions: Btn[] = [{ text: "➕ One more", callback_data: `pa:m:${id}` }];
      if (o.qty > 1) actions.push({ text: "➖ One less", callback_data: `pa:l:${id}` });
      actions.push({ text: "✖ Skip", callback_data: `pa:x:${id}` });
      return [[{ text: `✅ Add ${tail}`, callback_data: `pa:c:${id}` }], actions];
    }
    case "in": {
      const actions: Btn[] = [{ text: "➕ One more", callback_data: `bk:a:${pid}:1` }];
      if (o.qty > 1) actions.push({ text: "➖ One less", callback_data: `bk:x:${pid}:1` });
      actions.push({ text: o.qty > 1 ? "✖ Remove all" : "✖ Remove", callback_data: `bk:x:${pid}:${o.qty}` });
      return [[{ text: `✔ In basket ${tail}`, callback_data: pid === undefined ? NOOP : `noop:p:${pid}` }], actions];
    }
    case "removed":
      return [
        [{ text: `🚫 Removed ${tail}`, callback_data: `noop:p:${pid}` }],
        [{ text: "↩ Add again", callback_data: `bk:a:${pid}:${o.qty}` }],
      ];
    case "skipped":
      return [
        [{ text: `⏭ Skipped ${tail}`, callback_data: pid === undefined ? NOOP : `noop:p:${pid}` }],
        [pid === undefined ? { text: "·", callback_data: NOOP } : { text: "↩ Add", callback_data: `bk:a:${pid}:${o.qty}` }],
      ];
    case "failed":
      return [
        [{ text: `⚠ ${(o.reason ?? "failed").slice(0, 20)} ${tail}`, callback_data: pid === undefined ? NOOP : `noop:p:${pid}` }],
        [pid === undefined ? { text: "·", callback_data: NOOP } : { text: "↩ Try again", callback_data: `bk:a:${pid}:${o.qty}` }],
      ];
    case "done":
      return [[{ text: "✔ Done", callback_data: NOOP }], [{ text: "·", callback_data: NOOP }]];
  }
}

/**
 * Replace one block in a keyboard: the last two matching rows (info + action)
 * become `block`, earlier matching rows (the title) get `titleCb`, and the
 * status row at the bottom shows `basketTotal` when given. Row count is
 * unchanged, so nothing below the block moves.
 */
function rewriteRows(rows: KeyboardRow[], matches: (cb: string) => boolean, block: Btn[][], titleCb: string, basketTotal: string | null = null): KeyboardRow[] {
  const hit = rows.map((row, i) => (row.some((b) => matches(cbOf(b) ?? "")) ? i : -1)).filter((i) => i >= 0);
  if (hit.length === 0) return rows;
  const actionIdx = hit[hit.length - 1]!;
  const infoIdx = hit.length >= 2 ? hit[hit.length - 2]! : -1;
  return rows.map((row, i) => {
    if (i === infoIdx) return block[0]!;
    if (i === actionIdx) return block[1]!;
    if (hit.includes(i)) return row.map((b) => ({ text: b.text, callback_data: titleCb }));
    if (basketTotal && row.some((b) => cbOf(b) === STATUS_CB)) return [{ text: `🧺 AH basket now: ${basketTotal}`, callback_data: STATUS_CB }];
    return row;
  });
}

/**
 * Confirm keyboard for queued basket actions: a block per product (title
 * rows, "✅ Add ×qty — €price", then ➕ ➖ ✖), an "Add all" row when there are
 * several, and a status row that later shows the running basket total.
 */
async function pendingKeyboard(db: Db, pending: Array<{ id: string; tool: string; args: Record<string, unknown> }>): Promise<InlineKeyboard | undefined> {
  if (pending.length === 0) return undefined;
  const addIds = pending.filter((p) => p.tool === "basket_add").map((p) => Number(p.args.id)).filter((n) => Number.isInteger(n) && n > 0);
  const [titles, prices] = await Promise.all([productTitles(db, addIds), productPrices(db, addIds)]);
  const kb = new InlineKeyboard();
  let adds = 0;
  for (const p of pending) {
    const confirm = `pa:c:${p.id}`;
    if (p.tool === "basket_add") {
      adds++;
      const id = Number(p.args.id);
      const qty = typeof p.args.qty === "number" && p.args.qty > 0 ? p.args.qty : 1;
      const title = titles.get(id) ?? `AH #${String(p.args.id)}`;
      const price = prices.get(id) ?? null;
      for (const row of wrapLabel(`🧺 ${title}`)) kb.text(row, confirm).row();
      for (const row of blockRows("pending", { qty, unit: price, pendingId: p.id })) {
        for (const b of row) kb.text(b.text, b.callback_data);
        kb.row();
      }
    } else {
      const label = p.tool === "basket_fill_from_list" ? "🧺 Fill the AH basket from the list" : p.tool === "basket_clear" ? "🗑 Clear the whole AH basket" : `Confirm ${p.tool}`;
      for (const row of wrapLabel(label)) kb.text(row, confirm).row();
      kb.text("✅ Yes, do it", confirm).row();
      kb.text("✖ Skip", `pa:x:${p.id}`).row();
    }
  }
  if (adds > 1) kb.text(`✅ Add all (${adds})`, "pa:all").row();
  // Status row: present from the start so updating it never changes the row count.
  kb.text("🧺 Tap ✅ to put it in the AH basket", STATUS_CB).row();
  return kb;
}

/** After a confirmed fill: a block per added line in the "in basket" state. */
function removeKeyboard(result: unknown): InlineKeyboard | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as { changes?: BasketChange[]; basketTotal?: unknown };
  if (!Array.isArray(r.changes)) return undefined;
  const added = r.changes.filter((c) => c.delta > 0).slice(0, 20);
  if (added.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const c of added) {
    for (const row of wrapLabel(`🧺 ${c.title}`)) kb.text(row, `noop:p:${c.productId}`).row();
    for (const row of blockRows("in", { qty: c.delta, unit: typeof c.price === "number" ? c.price : null, pid: c.productId })) {
      for (const b of row) kb.text(b.text, b.callback_data);
      kb.row();
    }
  }
  kb.text(typeof r.basketTotal === "string" ? `🧺 AH basket now: ${r.basketTotal}` : "🧺 AH basket", STATUS_CB).row();
  return kb;
}

function summariseShopResult(tool: string | undefined, result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  const total = typeof r.basketTotal === "string" ? ` Basket now: ${r.basketTotal}.` : "";
  if (tool === "basket_add" && typeof r.added === "string") {
    const price = typeof r.price === "string" ? ` (${r.price})` : "";
    const now = typeof r.inBasketNow === "number" && r.inBasketNow !== r.qty ? `, ${r.inBasketNow} in the basket now` : "";
    return `Added ${r.added}${r.qty ? ` ×${String(r.qty)}` : ""}${price} to the AH basket${now}.${total}`;
  }
  if (tool === "basket_remove") {
    if (r.removed === null) return `${String(r.name ?? "That product")} was not in the AH basket.`;
    if (typeof r.removed === "string") return `Removed ${r.removed}${r.qtyRemoved ? ` ×${String(r.qtyRemoved)}` : ""} from the AH basket.${total}`;
  }
  if (tool === "basket_clear") {
    const cleared = typeof r.cleared === "number" ? r.cleared : 0;
    const remaining = typeof r.remaining === "number" ? r.remaining : 0;
    if (cleared === 0) return `AH basket: nothing to clear.${typeof r.note === "string" ? ` ${r.note}.` : ""}`;
    return `Cleared ${cleared} lines from the AH basket.${remaining ? ` ${remaining} lines remain (already in an open order).` : ""}${total}`;
  }
  if (tool === "basket_fill_from_list") {
    const added = Array.isArray(r.added) ? (r.added as string[]) : [];
    const failed = Array.isArray(r.failed) ? (r.failed as string[]) : [];
    const need = Array.isArray(r.needChoice) ? (r.needChoice as string[]) : [];
    const notFound = Array.isArray(r.notFound) ? (r.notFound as string[]) : [];
    const parts: string[] = [];
    if (added.length) parts.push(`Added to the AH basket:\n${added.map((a) => `• ${a}`).join("\n")}`);
    if (failed.length) parts.push(`Failed: ${failed.join("; ")}`);
    if (need.length) parts.push(`Need you to choose: ${need.join(", ")}`);
    if (notFound.length) parts.push(`Not found: ${notFound.join(", ")}`);
    if (typeof r.basketTotal === "string") parts.push(`Basket now: ${r.basketTotal}.`);
    parts.push("Open the AH app to review and check out. I never pay.");
    return parts.join("\n\n");
  }
  return "";
}

function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
