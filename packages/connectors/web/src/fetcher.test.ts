import test from "node:test";
import assert from "node:assert/strict";
import { WebFetcher, detectBlock, type FetchImpl } from "./fetcher.js";

test("detectBlock recognises statuses and challenge pages", () => {
  assert.equal(detectBlock(403, ""), "http 403");
  assert.equal(detectBlock(503, "<html>Er is iets misgegaan</html>"), "http 503");
  assert.equal(detectBlock(200, "<html><head><title>Just a moment...</title>"), "cloudflare challenge");
  assert.equal(detectBlock(200, "To discuss automated access to Amazon data please contact api-services-support@amazon.com"), "amazon automated-access page");
  assert.equal(detectBlock(200, "Title: IP address 34.96.49.65 is blocked"), "ip blocked");
  assert.equal(detectBlock(200, "<html><body>Powered and protected by  ![Image 1: Akamai](x)"), "akamai block page");
  assert.equal(detectBlock(200, "<html><head><title>Kabel kopen</title></head><body>fine <script src=recaptcha.js></script></body>"), null);
});

function fakeFetch(handler: (url: string, init?: RequestInit) => Response): { impl: FetchImpl; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: unknown, init?: unknown) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init as RequestInit);
  }) as unknown as FetchImpl;
  return { impl, calls };
}

test("fetchPage falls back to Jina when the site blocks us, then cools the host down", async () => {
  let now = 1_000_000;
  const { impl, calls } = fakeFetch((url) => {
    if (url.startsWith("https://r.jina.ai/")) {
      return new Response(JSON.stringify({ code: 200, data: { title: "Amazon product", url: "https://www.amazon.nl/dp/X1", text: "Some readable product text with €9,99 price" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("<html><body>Er is iets misgegaan</body></html>", { status: 503, headers: { "content-type": "text/html" } });
  });
  const f = new WebFetcher({ fetchImpl: impl, minGapMs: 0, now: () => now });

  const r1 = await f.fetchPage("https://www.amazon.nl/dp/X1");
  assert.equal(r1.via, "jina");
  assert.equal(r1.blocked, false);
  assert.equal(r1.title, "Amazon product");
  assert.match(r1.body, /readable product text/u);
  assert.deepEqual(calls, ["https://www.amazon.nl/dp/X1", "https://r.jina.ai/https://www.amazon.nl/dp/X1"]);

  // Same host, different page: direct is skipped during the cooldown.
  const r2 = await f.fetchPage("https://www.amazon.nl/dp/X2");
  assert.equal(r2.via, "jina");
  assert.deepEqual(calls.slice(2), ["https://r.jina.ai/https://www.amazon.nl/dp/X2"]);

  // Cached: no new calls.
  await f.fetchPage("https://www.amazon.nl/dp/X2");
  assert.equal(calls.length, 3);

  // After the cooldown, direct is tried again.
  now += 21 * 60_000;
  await f.fetchPage("https://www.amazon.nl/dp/X3");
  assert.equal(calls[3], "https://www.amazon.nl/dp/X3");
});

test("fetchPage returns a direct HTML page and reports a block from both transports", async () => {
  const { impl } = fakeFetch((url) => {
    if (url.startsWith("https://r.jina.ai/")) {
      return new Response(JSON.stringify({ data: { title: "", url, text: "Title: IP address 1.2.3.4 is blocked" } }), { status: 200 });
    }
    if (url.includes("bol.com")) return new Response("denied", { status: 403 });
    return new Response("<html><head><title>OK</title></head><body>hoi</body></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  });
  const f = new WebFetcher({ fetchImpl: impl, minGapMs: 0 });
  const ok = await f.fetchPage("https://www.coolblue.nl/x");
  assert.equal(ok.via, "direct");
  assert.equal(ok.blocked, false);
  assert.match(ok.body, /<title>OK<\/title>/u);

  const blocked = await f.fetchPage("https://www.bol.com/nl/nl/p/x/9200000000000001/");
  assert.equal(blocked.blocked, true);
  assert.match(blocked.blockReason ?? "", /jina: ip blocked/u);

  const directOnly = await f.fetchPage("https://www.bol.com/nl/nl/p/y/9200000000000002/", { mode: "direct" });
  assert.equal(directOnly.blocked, true);
});

test("proxy transport is selected for configured hosts only", () => {
  const f = new WebFetcher({ proxyUrl: "http://user:pw@127.0.0.1:8080", proxyHosts: ["bol.com", "amazon.nl"] });
  assert.equal(f.hasProxy, true);
  assert.equal(f.transportFor("https://www.bol.com/x"), "proxy");
  assert.equal(f.transportFor("https://www.amazon.nl/dp/B07BBLTX96"), "proxy");
  assert.equal(f.transportFor("https://www.coolblue.nl/x"), "direct");
  assert.equal(new WebFetcher().transportFor("https://www.bol.com/x"), "direct");
});
