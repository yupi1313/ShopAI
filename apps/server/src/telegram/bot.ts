import { Bot, GrammyError, HttpError, type Context } from "grammy";
import {
  and,
  chats,
  eq,
  llmCalls,
  members,
  households,
  sqlTag,
  type Db,
  type Household,
  type Member,
} from "@shopai/db";
import { addressesBot, clearTurns, escapeHtml, type Agent, type ToolContext } from "@shopai/core";
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
import type { AppConfig } from "./../config.js";
import type { AppLogger } from "./../logger.js";
import { pickLang, t, type Lang } from "./../i18n.js";
import { listKeyboard } from "./keyboard.js";
import { reloadHousehold } from "./../bootstrap.js";

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

  // ---- free text -> agent ----
  bot.on("message:text", async (ctx) => {
    if (!ctx.member) return;
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;
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
        for (const chunk of chunkText(out.text, 4000)) {
          await ctx.reply(chunk, replyOpts);
        }
        if (out.toolsUsed.some((n) => LIST_MUTATING_TOOLS.has(n))) {
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
  { command: "help", description: "How to use me" },
  { command: "reset", description: "Forget the conversation context" },
  { command: "id", description: "Show my Telegram id" },
];

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
