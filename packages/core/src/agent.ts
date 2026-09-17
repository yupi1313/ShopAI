// The agent loop: user message -> messages[] -> ZAGI -> tool calls -> repeat -> reply.
// Interface-agnostic: Telegram and the web page both call runAgent().

import {
  DEFAULT_CHAT_MAX_TOKENS,
  ZagiEmptyReplyError,
  ZagiHttpError,
  type ChatMessage,
  type ZagiClient,
} from "@shopai/llm";
import { and, eq, llmCalls, pendingActions, type Db, type StoredTurn } from "@shopai/db";
import type { Capability, Logger, ToolContext } from "./types.js";
import { ToolRegistry, compactJson, type ToolExecution } from "./tools.js";
import { appendTurns, loadTurns } from "./memory.js";

export const MAX_TOOL_ROUNDS = 8;
export const PENDING_ACTION_TTL_MS = 15 * 60 * 1000;

export interface AgentDeps {
  llm: ZagiClient;
  db: Db;
  log: Logger;
  capabilities: Capability[];
  /** Static part of the system prompt (identity, household, rules). */
  buildSystemPrompt(ctx: ToolContext): Promise<string>;
}

export interface AgentInput {
  ctx: ToolContext;
  userText: string;
  /** Called after each tool round with a short status, for "typing…"-style feedback. */
  onProgress?(status: string): Promise<void> | void;
}

export interface PendingConfirmation {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface AgentOutput {
  text: string;
  toolsUsed: string[];
  /** Every tool executed this turn with its result, so interfaces can render follow-up buttons. */
  executions: ToolExecution[];
  /** Shop side effects the model proposed; the interface renders Confirm/Cancel. */
  pending: PendingConfirmation[];
  rounds: number;
}

export class Agent {
  readonly registry: ToolRegistry;

  constructor(private readonly deps: AgentDeps) {
    this.registry = new ToolRegistry(deps.capabilities);
  }

  async run(input: AgentInput): Promise<AgentOutput> {
    const { ctx, userText } = input;
    const { llm, db, log } = this.deps;
    const specs = this.registry.specs();

    const system = await this.composeSystemPrompt(ctx);
    const history = await loadTurns(db, ctx.chatKey);
    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history.map<ChatMessage>((t) => ({
        role: t.role,
        content: t.role === "user" && t.who ? `[${t.who}] ${t.content}` : t.content,
      })),
      { role: "user", content: ctx.chatKind === "private" ? userText : `[${ctx.member.displayName}] ${userText}` },
    ];

    const toolsUsed: string[] = [];
    const executions: ToolExecution[] = [];
    const pending: PendingConfirmation[] = [];
    let finalText = "";
    let rounds = 0;

    for (; rounds < MAX_TOOL_ROUNDS; rounds++) {
      let res;
      try {
        res = await llm.chatWithBudget({
          messages,
          tools: specs,
          maxTokens: DEFAULT_CHAT_MAX_TOKENS,
          temperature: 0.2,
        });
      } catch (err) {
        await this.logCall(ctx, null, err);
        if (err instanceof ZagiEmptyReplyError) {
          finalText = "The model ran out of thinking budget on this one. Try a shorter request.";
        } else if (err instanceof ZagiHttpError) {
          finalText = `The model gateway answered HTTP ${err.status}. Try again in a minute.`;
        } else {
          finalText = "I could not reach the model. Try again in a minute.";
        }
        log.error({ err, chatKey: ctx.chatKey }, "llm call failed");
        break;
      }
      await this.logCall(ctx, res, null);

      if (res.toolCalls.length === 0) {
        finalText = res.text.trim();
        break;
      }

      messages.push(res.assistantMessage);
      const names = res.toolCalls.map((c) => c.name);
      await input.onProgress?.(names.join(", "));

      for (const call of res.toolCalls) {
        const tool = this.registry.get(call.name);
        if (tool?.sideEffect === "shop") {
          const parsed = safeParseArgs(call.arguments);
          const [row] = await db
            .insert(pendingActions)
            .values({
              chatKey: ctx.chatKey,
              memberId: ctx.member.id,
              tool: call.name,
              args: parsed,
              expiresAt: new Date(ctx.now.getTime() + PENDING_ACTION_TTL_MS),
            })
            .returning({ id: pendingActions.id });
          if (row) pending.push({ id: row.id, tool: call.name, args: parsed });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            name: call.name,
            content: JSON.stringify({
              status: "awaiting_human_confirmation",
              note: "This action changes a shop basket. It has been queued; a family member must tap Confirm. Tell the user what you proposed and that it awaits confirmation.",
            }),
          });
          toolsUsed.push(call.name);
          continue;
        }
        const exec = await this.registry.execute(call.name, call.arguments, ctx);
        toolsUsed.push(call.name);
        executions.push(exec);
        log.info({ tool: call.name, ok: exec.ok, ms: exec.ms, chatKey: ctx.chatKey }, "tool executed");
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name: call.name,
          content: compactJson(exec.result),
        });
      }
    }

    if (!finalText) {
      finalText = rounds >= MAX_TOOL_ROUNDS ? "I did several steps but did not reach a final answer. What exactly should I do next?" : "…";
    }

    const now = ctx.now.toISOString();
    const newTurns: StoredTurn[] = [
      { role: "user", who: ctx.chatKind === "private" ? undefined : ctx.member.displayName, content: userText, at: now },
      { role: "assistant", content: finalText, at: now },
    ];
    await appendTurns(db, ctx.household.id, ctx.chatKey, newTurns);

    return { text: finalText, toolsUsed, executions, pending, rounds: rounds + 1 };
  }

  /** Run a queued shop action after a human confirmed it. Idempotent per row. */
  async confirmPending(id: string, ctx: ToolContext): Promise<{ ok: boolean; tool?: string; result?: unknown; reason?: string }> {
    const rows = await this.deps.db
      .update(pendingActions)
      .set({ status: "confirmed" })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")))
      .returning();
    const row = rows[0];
    if (!row) return { ok: false, reason: "already handled or unknown" };
    if (row.expiresAt.getTime() < Date.now()) {
      await this.deps.db.update(pendingActions).set({ status: "expired" }).where(eq(pendingActions.id, id));
      return { ok: false, reason: "expired" };
    }
    const exec: ToolExecution = await this.registry.execute(row.tool, JSON.stringify(row.args), ctx);
    this.deps.log.info({ tool: row.tool, ok: exec.ok, ms: exec.ms }, "confirmed action executed");
    return { ok: exec.ok, tool: row.tool, result: exec.result };
  }

  async cancelPending(id: string): Promise<boolean> {
    const rows = await this.deps.db
      .update(pendingActions)
      .set({ status: "cancelled" })
      .where(and(eq(pendingActions.id, id), eq(pendingActions.status, "pending")))
      .returning({ id: pendingActions.id });
    return rows.length > 0;
  }

  private async composeSystemPrompt(ctx: ToolContext): Promise<string> {
    const parts = [await this.deps.buildSystemPrompt(ctx)];
    for (const cap of this.deps.capabilities) {
      if (!cap.promptFragment) continue;
      try {
        const frag = await cap.promptFragment(ctx);
        if (frag.trim()) parts.push(frag.trim());
      } catch (err) {
        this.deps.log.warn({ err, capability: cap.name }, "prompt fragment failed");
      }
    }
    return parts.join("\n\n");
  }

  private async logCall(
    ctx: ToolContext,
    res: Awaited<ReturnType<ZagiClient["chat"]>> | null,
    err: unknown,
  ): Promise<void> {
    try {
      await this.deps.db.insert(llmCalls).values({
        chatKey: ctx.chatKey,
        memberId: ctx.member.id,
        capability: null,
        model: this.deps.llm.model,
        promptTokens: res?.usage.promptTokens ?? null,
        completionTokens: res?.usage.completionTokens ?? null,
        reasoningTokens: res?.usage.reasoningTokens ?? null,
        cachedTokens: res?.usage.cachedTokens ?? null,
        finishReason: res?.finishReason ?? null,
        latencyMs: res?.latencyMs ?? null,
        toolNames: res ? res.toolCalls.map((c) => c.name) : null,
        error: err ? (err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : String(err)) : null,
      });
    } catch (e) {
      this.deps.log.warn({ err: e }, "failed to log llm call");
    }
  }
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return { raw };
  }
}
