import { test } from "node:test";
import assert from "node:assert/strict";
import { ZagiEmptyReplyError, createZagiClient, extractJson, zagiConfigFromEnv } from "./index.js";

test("extractJson: plain, fenced, and prose-wrapped", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Sure! Here it is: [1,2,3] hope it helps'), [1, 2, 3]);
  assert.throws(() => extractJson("no json here"));
});

test("zagiConfigFromEnv: null without key or url, defaults the model", () => {
  assert.equal(zagiConfigFromEnv({}), null);
  assert.equal(zagiConfigFromEnv({ ZAGI_API_KEY: "k" }), null);
  const cfg = zagiConfigFromEnv({ ZAGI_API_KEY: "k", ZAGI_BASE_URL: "https://x/v1" });
  assert.deepEqual(cfg, { apiKey: "k", baseUrl: "https://x/v1", model: "glm-5.3-flash" });
});

function fakeFetch(bodies: Array<Record<string, unknown>>): { fetch: typeof fetch; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const body = bodies.shift() ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

test("chatWithBudget: empty reply with finish_reason=length retries once at double budget", async () => {
  const empty = { choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { completion_tokens: 6000 } };
  const ok = { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } } };
  const { fetch, calls } = fakeFetch([empty, ok]);
  const client = createZagiClient({ baseUrl: "https://x/v1/", apiKey: "k", model: "m", fetchImpl: fetch });
  const res = await client.chatWithBudget({ messages: [{ role: "user", content: "hi" }], maxTokens: 1000 });
  assert.equal(res.text, "done");
  assert.equal(res.usage.reasoningTokens, 30);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.max_tokens, 1000);
  assert.equal(calls[1]?.max_tokens, 2000);
});

test("chat: empty reply with finish_reason=stop is an error, not a retry", async () => {
  const empty = { choices: [{ message: { content: "" }, finish_reason: "stop" }] };
  const { fetch, calls } = fakeFetch([empty, empty]);
  const client = createZagiClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: fetch });
  await assert.rejects(() => client.chatWithBudget({ messages: [{ role: "user", content: "hi" }] }), ZagiEmptyReplyError);
  assert.equal(calls.length, 1);
});

test("chat: tool calls are surfaced and echoed into the assistant message", async () => {
  const body = {
    choices: [
      {
        message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_add", arguments: '{"items":[]}' } }] },
        finish_reason: "tool_calls",
      },
    ],
  };
  const { fetch, calls } = fakeFetch([body]);
  const client = createZagiClient({ baseUrl: "https://x/v1", apiKey: "k", model: "m", fetchImpl: fetch });
  const res = await client.chat({
    messages: [{ role: "user", content: "add" }],
    tools: [{ type: "function", function: { name: "list_add", description: "d", parameters: { type: "object" } } }],
  });
  assert.equal(res.toolCalls.length, 1);
  assert.equal(res.toolCalls[0]?.name, "list_add");
  assert.equal(res.assistantMessage.tool_calls?.[0]?.id, "c1");
  assert.equal(calls[0]?.tool_choice, "auto");
});
