import { Bot, GrammyError, HttpError, type Context } from "grammy";
import {
  and,
  chats,
  eq,
  inArray,
  llmCalls,
  members,
  households,
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

  // Confirm / cancel a queued shop action (basket_add, basket_fill_from_list).
  bot.callbackQuery(/^pa:(c|x):(.+)$/u, async (ctx) => {
    if (!ctx.member || !deps.agent) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const kind = ctx.match[1];
    const id = ctx.match[2]!;
    if (kind === "x") {
      await deps.agent.cancelPending(id);
      await ctx.answerCallbackQuery({ text: "Cancelled" }).catch(() => {});
      // Only this product's rows go; the other proposed products stay tappable.
      await dropButtonRow(ctx, `pa:c:${id}`);
      return;
    }
    await ctx.answerCallbackQuery({ text: "Working…" }).catch(() => {});
    // Drop only the tapped row so the other proposed products stay tappable.
    await dropButtonRow(ctx, `pa:c:${id}`);
    try {
      const res = await deps.agent.confirmPending(id, toolCtx(ctx));
      if (!res.ok) {
        await ctx.reply(`Could not do it: ${res.reason ?? "action failed"}.`);
        return;
      }
      const kb = removeKeyboard(res.result);
      await ctx.reply(`✅ ${summariseShopResult(res.tool, res.result) || "Done."}`, kb ? { reply_markup: kb } : {});
      if (res.tool === "basket_fill_from_list") await renderList(ctx, "send");
    } catch (err) {
      log.error({ err, id }, "confirm failed");
      await ctx.reply("Something went wrong doing that. Try again.");
    }
  });

  // One-tap "take it out again" after a confirmed basket add: bk:x:<productId>:<qty>
  bot.callbackQuery(/^bk:x:(\d+):(\d+)$/u, async (ctx) => {
    if (!ctx.member || !cfg.SESSION_SECRET) {
      await ctx.answerCallbackQuery().catch(() => {});
      return;
    }
    const productId = Number(ctx.match[1]);
    const qty = Number(ctx.match[2]);
    await ctx.answerCallbackQuery({ text: "Removing…" }).catch(() => {});
    try {
      const ah = buildClient({ db, sessionSecret: cfg.SESSION_SECRET }, household.id);
      const current = await ah.basket();
      const line = current.items.find((i) => i.productId === productId);
      const title = (await productTitles(db, [productId])).get(productId) ?? `product ${productId}`;
      if (!line) {
        await dropButtonRow(ctx, `bk:x:${productId}:${qty}`);
        await ctx.reply(`${title} is no longer in the AH basket.`);
        return;
      }
      const target = Math.max(0, line.quantity - qty);
      const basket = await ah.basketItemsUpdate([{ productId, quantity: target }]);
      await dropButtonRow(ctx, `bk:x:${productId}:${qty}`);
      const total = basket.totalFormatted ?? (basket.totalPrice === null ? "" : `€${basket.totalPrice.toFixed(2)}`);
      await ctx.reply(`Removed ${title} ×${line.quantity - target} from the AH basket${target ? ` (${target} left)` : ""}.${total ? ` Basket now: ${total}.` : ""}`);
    } catch (err) {
      log.error({ err, productId }, "basket remove button failed");
      await ctx.reply("Could not remove it. Ask me in chat and I'll try again.");
    }
  });

  /**
   * Remove every row that belongs to one action (all rows carry that action's
   * callback data, the title rows and the quantity/price row alike) from the
   * tapped message's inline keyboard; the other actions stay.
   */
  async function dropButtonRow(ctx: BotContext, callbackData: string): Promise<void> {
    const msg = ctx.callbackQuery?.message;
    const rows = msg && "reply_markup" in msg ? (msg.reply_markup?.inline_keyboard ?? []) : [];
    const kept = rows.filter((row) => !row.some((b) => "callback_data" in b && b.callback_data === callbackData));
    await ctx.editMessageReplyMarkup({ reply_markup: kept.length ? { inline_keyboard: kept } : undefined }).catch(() => {});
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

async function productPrices(db: Db, ids: number[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ productId: products.productId, price: products.price })
    .from(products)
    .where(and(eq(products.store, "ah"), inArray(products.productId, ids.map(String))));
  for (const r of rows) out.set(Number(r.productId), r.price === null ? null : `€${Number(r.price).toFixed(2)}`);
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

/**
 * Confirm buttons for queued basket actions. Each product takes its own
 * block: the full title over one or more rows, then "✅ ×qty — €price" with
 * the ✖ beside it. All rows of a block share the action's callback data, so
 * a tap on any of them applies it and dropButtonRow removes the whole block.
 */
async function pendingKeyboard(db: Db, pending: Array<{ id: string; tool: string; args: Record<string, unknown> }>): Promise<InlineKeyboard | undefined> {
  if (pending.length === 0) return undefined;
  const addIds = pending.filter((p) => p.tool === "basket_add").map((p) => Number(p.args.id)).filter((n) => Number.isInteger(n) && n > 0);
  const [titles, prices] = await Promise.all([productTitles(db, addIds), productPrices(db, addIds)]);
  const kb = new InlineKeyboard();
  for (const p of pending) {
    const confirm = `pa:c:${p.id}`;
    const cancel = `pa:x:${p.id}`;
    if (p.tool === "basket_add") {
      const id = Number(p.args.id);
      const qty = typeof p.args.qty === "number" && p.args.qty > 0 ? p.args.qty : 1;
      const title = titles.get(id) ?? `AH #${String(p.args.id)}`;
      const price = prices.get(id);
      const rows = wrapLabel(`🧺 ${title}`);
      for (const row of rows) kb.text(row, confirm).row();
      kb.text(`✅ Add ×${qty}${price ? ` — ${price}` : ""}${qty > 1 && price ? ` (${money(Number(price.slice(1)) * qty)})` : ""}`, confirm).text("✖", cancel).row();
    } else {
      const label = p.tool === "basket_fill_from_list" ? "🧺 Fill the AH basket from the list" : p.tool === "basket_clear" ? "🗑 Clear the whole AH basket" : `Confirm ${p.tool}`;
      for (const row of wrapLabel(label)) kb.text(row, confirm).row();
      kb.text("✅ Yes, do it", confirm).text("✖", cancel).row();
    }
  }
  return kb;
}

function money(n: number): string {
  return `€${n.toFixed(2)}`;
}

/** After a confirmed add: a "take it out" block per added line, laid out like the confirm blocks. */
function removeKeyboard(result: unknown): InlineKeyboard | undefined {
  if (!result || typeof result !== "object") return undefined;
  const changes = (result as { changes?: BasketChange[] }).changes;
  if (!Array.isArray(changes)) return undefined;
  const added = changes.filter((c) => c.delta > 0).slice(0, 20);
  if (added.length === 0) return undefined;
  const kb = new InlineKeyboard();
  for (const c of added) {
    const cb = `bk:x:${c.productId}:${c.delta}`;
    for (const row of wrapLabel(c.title)) kb.text(row, cb).row();
    kb.text(`✖ Remove ×${c.delta}${c.now > c.delta ? ` (${c.now} in basket)` : ""}`, cb).row();
  }
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
