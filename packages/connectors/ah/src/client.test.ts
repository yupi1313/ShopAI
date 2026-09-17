import { test } from "node:test";
import assert from "node:assert/strict";
import { AhClient, BASKET_MUTATION, extractCode, type TokenSource } from "./client.js";
import { AhAuthExpiredError, AhGraphqlError } from "./types.js";

test("extractCode: from a redirect URL", () => {
  assert.equal(extractCode("appie://login-exit?code=abc123&state=x"), "abc123");
  assert.equal(extractCode("  https://login.ah.nl/x?foo=1&code=A%2FB "), "A/B");
});

test("extractCode: bare code", () => {
  assert.equal(extractCode("justacode"), "justacode");
});

test("extractCode: rejects junk", () => {
  assert.equal(extractCode("no code here"), null);
  assert.equal(extractCode("https://login.ah.nl/secure/oauth/authorize?client_id=appie"), null);
  assert.equal(extractCode(""), null);
});

const memberTokens: TokenSource = {
  get: async () => ({ accessToken: "member-token", refreshToken: "r", expiresAt: Date.now() + 60_000, member: true }),
};
const anonTokens: TokenSource = {
  get: async () => ({ accessToken: "anon-token", refreshToken: "", expiresAt: Date.now() + 60_000, member: false }),
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    calls.push({ url, init: (init ?? {}) as RequestInit });
    return handler(url, (init ?? {}) as RequestInit);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("basketItemsUpdate posts the captured mutation with the member token and parses the basket", async () => {
  const { impl, calls } = fakeFetch(() =>
    new Response(
      JSON.stringify({
        data: {
          basketItemsUpdate: {
            result: {
              itemsInOrder: [{ id: "1", quantity: 2, product: { id: 159760 } }],
              summary: { quantity: 2, price: { totalPrice: { amount: 2.58, formattedV2: "€ 2,58" } } },
            },
          },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const ah = new AhClient(memberTokens, impl);
  const basket = await ah.basketItemsUpdate([{ productId: 159760, quantity: 2 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.ah.nl/graphql");
  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer member-token");
  assert.equal(headers["x-application"], "AHWEBSHOP");
  assert.equal(headers["x-require-member"], "true");
  const body = JSON.parse(String(calls[0]!.init.body)) as { operationName: string; variables: unknown; query: string };
  assert.equal(body.operationName, "basketItemsUpdate");
  assert.deepEqual(body.variables, { items: [{ id: 159760, quantity: 2, description: null }] });
  assert.equal(body.query, BASKET_MUTATION);
  assert.deepEqual(basket, {
    items: [{ id: "1", productId: 159760, quantity: 2 }],
    quantity: 2,
    totalPrice: 2.58,
    totalFormatted: "€ 2,58",
  });
});

test("basket writes need a member session; GraphQL errors surface as AhGraphqlError", async () => {
  const { impl, calls } = fakeFetch(() => new Response(JSON.stringify({ data: null, errors: [{ message: "Unauthorized" }] }), { status: 200 }));
  await assert.rejects(() => new AhClient(anonTokens, impl).basketItemsUpdate([{ productId: 1, quantity: 1 }]), AhAuthExpiredError);
  assert.equal(calls.length, 0);
  await assert.rejects(() => new AhClient(memberTokens, impl).basket(), (err: unknown) => err instanceof AhGraphqlError && /Unauthorized/u.test(err.message));
});
