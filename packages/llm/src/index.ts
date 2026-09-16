// ZAGI (ZillaAGI) — the in-house LLM behind an OpenAI-compatible
// chat-completions endpoint. Ported from Oddzilla's client and extended with
// multi-turn messages and tool calls.
//
// Three lessons baked in (see docs/ARCHITECTURE.md §3):
//   1. The base URL INCLUDES `/v1`; we post to `<base>/chat/completions`.
//   2. The model is PINNED; `/v1/models` lists several and the first is arbitrary.
//   3. glm-5.3-flash is a reasoning model: hidden reasoning tokens are spent
//      BEFORE any visible text. A small max_tokens returns empty content with
//      finish_reason "length". That is a budget error, never "nothing to say",
//      so `chat()` throws ZagiEmptyReplyError and `chatWithBudget()` retries
//      once at double the budget.

import { setTimeout as delay } from "node:timers/promises";

export interface ZagiConfig {
  /** Chat-completions base, INCLUDING the `/v1` segment. */
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string exactly as the model produced it. */
  arguments: string;
}

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  /** Present on an assistant turn that requested tools. */
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  /** Present on a tool-result turn. */
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  cachedTokens: number | null;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage: ChatUsage;
  latencyMs: number;
  /** The assistant message as the API returned it, ready to append to history. */
  assistantMessage: ChatMessage;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: "auto" | "none";
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export class ZagiHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`zagi returned HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = "ZagiHttpError";
  }
}

export class ZagiEmptyReplyError extends Error {
  constructor(readonly finishReason: string | null) {
    super(
      finishReason === "length"
        ? "zagi returned an empty reply after exhausting max_tokens on reasoning"
        : `zagi returned an empty reply (finish_reason=${finishReason ?? "unknown"})`,
    );
    this.name = "ZagiEmptyReplyError";
  }
}

export const DEFAULT_CHAT_MAX_TOKENS = 6000;
export const DEFAULT_BATCH_MAX_TOKENS = 16000;

/** Read ZAGI config from env, or null when it is not set up (features idle). */
export function zagiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZagiConfig | null {
  const apiKey = (env.ZAGI_API_KEY ?? "").trim();
  const baseUrl = (env.ZAGI_BASE_URL ?? "").trim();
  if (!apiKey || !baseUrl) return null;
  const model = (env.ZAGI_MODEL ?? "").trim() || "glm-5.3-flash";
  return { baseUrl, apiKey, model };
}

export interface ZagiClient {
  readonly model: string;
  chat(opts: ChatOptions): Promise<ChatResult>;
  /** `chat` plus the budget policy: on empty+length, retry once at 2x max_tokens. */
  chatWithBudget(opts: ChatOptions): Promise<ChatResult>;
}

interface RawResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
  error?: unknown;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function createZagiClient(cfg: ZagiConfig): ZagiClient {
  const baseUrl = cfg.baseUrl.replace(/\/+$/u, "");
  const doFetch = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs ?? 180_000;

  async function once(opts: ChatOptions): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const started = Date.now();
    try {
      const payload: Record<string, unknown> = {
        model: cfg.model,
        messages: opts.messages,
        max_tokens: opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS,
        temperature: opts.temperature ?? 0.2,
        stream: false,
      };
      if (opts.tools && opts.tools.length > 0) {
        payload.tools = opts.tools;
        payload.tool_choice = opts.toolChoice ?? "auto";
      }
      const res = await doFetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(payload),
      });
      const bodyText = await res.text();
      if (!res.ok) throw new ZagiHttpError(res.status, bodyText);
      let body: RawResponse;
      try {
        body = JSON.parse(bodyText) as RawResponse;
      } catch {
        throw new ZagiHttpError(res.status, `non-JSON body: ${bodyText.slice(0, 200)}`);
      }
      const choice = body.choices?.[0];
      const msg = choice?.message;
      const text = msg?.content ?? "";
      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((tc, i) => {
        const name = tc.function?.name;
        if (!name) return [];
        return [
          {
            id: tc.id ?? `call_${i}`,
            name,
            arguments: tc.function?.arguments ?? "{}",
          },
        ];
      });
      const finishReason = choice?.finish_reason ?? null;
      if (!text.trim() && toolCalls.length === 0) {
        throw new ZagiEmptyReplyError(finishReason);
      }
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: text || null,
        ...(toolCalls.length > 0
          ? {
              tool_calls: toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
      return {
        text,
        toolCalls,
        finishReason,
        usage: {
          promptTokens: numOrNull(body.usage?.prompt_tokens),
          completionTokens: numOrNull(body.usage?.completion_tokens),
          reasoningTokens: numOrNull(body.usage?.completion_tokens_details?.reasoning_tokens),
          cachedTokens: numOrNull(body.usage?.prompt_tokens_details?.cached_tokens),
        },
        latencyMs: Date.now() - started,
        assistantMessage,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  async function chat(opts: ChatOptions): Promise<ChatResult> {
    // One retry on transient transport / gateway failures. Budget errors are
    // NOT retried here; that is chatWithBudget's job, with a bigger budget.
    try {
      return await once(opts);
    } catch (err) {
      const transient =
        (err instanceof ZagiHttpError && (err.status === 429 || err.status >= 500)) ||
        (err instanceof Error && err.name === "TypeError"); // fetch network error
      if (!transient || opts.signal?.aborted) throw err;
      await delay(2000);
      return await once(opts);
    }
  }

  async function chatWithBudget(opts: ChatOptions): Promise<ChatResult> {
    try {
      return await chat(opts);
    } catch (err) {
      if (err instanceof ZagiEmptyReplyError && err.finishReason === "length") {
        const bigger = (opts.maxTokens ?? DEFAULT_CHAT_MAX_TOKENS) * 2;
        return await chat({ ...opts, maxTokens: bigger });
      }
      throw err;
    }
  }

  return { model: cfg.model, chat, chatWithBudget };
}

/**
 * Forgiving JSON extraction for model output: tolerates code fences and
 * stray prose around a single JSON object or array. Throws if nothing
 * parseable is found. Same posture as Oddzilla's risk-tier parser.
 */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }
  const firstObj = trimmed.indexOf("{");
  const firstArr = trimmed.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) throw new Error("no JSON found in model output");
  const start = Math.min(...starts);
  const closer = trimmed[start] === "{" ? "}" : "]";
  const end = trimmed.lastIndexOf(closer);
  if (end <= start) throw new Error("unterminated JSON in model output");
  return JSON.parse(trimmed.slice(start, end + 1)) as T;
}
