import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSearch, isDuckDuckGoAnomaly, parseDuckDuckGoHtml, type SearchProvider } from "./search.js";
import { WebError, type SearchResult } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(path.join(here, "fixtures", "ddg_bol.html"), "utf8");

test("parseDuckDuckGoHtml decodes redirect links, keeps snippets and drops ads", () => {
  const results = parseDuckDuckGoHtml(fixture);
  assert.ok(results.length >= 3, `expected results, got ${results.length}`);
  for (const r of results) {
    assert.match(r.url, /^https:\/\/www\.bol\.com\//u, r.url);
    assert.ok(!r.url.includes("y.js"));
    assert.ok(r.title.length > 5);
  }
  assert.match(results[0]!.title, /Belkin/u);
  assert.equal(results[0]!.url, "https://www.bol.com/nl/nl/p/belkin-usb-c-naar-usb-c-kabel-2m-zwart/9200000132189684/");
  assert.ok(results[0]!.snippet.length > 20);
  assert.equal(results[0]!.source, "duckduckgo");
});

test("isDuckDuckGoAnomaly flags the bot challenge page", () => {
  assert.equal(isDuckDuckGoAnomaly(202, "<html></html>"), true);
  assert.equal(isDuckDuckGoAnomaly(200, '<div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div>'), true);
  assert.equal(isDuckDuckGoAnomaly(200, fixture), false);
});

function provider(name: string, impl: () => Promise<SearchResult[]>): SearchProvider {
  return { name, search: impl };
}

test("WebSearch chain: first provider with results wins, failures are skipped", async () => {
  const calls: string[] = [];
  const chain = new WebSearch([
    provider("a", async () => {
      calls.push("a");
      throw new WebError("down", "provider");
    }),
    provider("b", async () => {
      calls.push("b");
      return [];
    }),
    provider("c", async () => {
      calls.push("c");
      return [{ title: "t", url: "https://x", snippet: "", source: "c" }];
    }),
  ]);
  const res = await chain.search("q");
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(res[0]!.source, "c");
  // cached: no new calls
  await chain.search("q");
  assert.deepEqual(calls, ["a", "b", "c"]);
});

test("WebSearch chain: all empty returns [], all failing throws", async () => {
  const empty = new WebSearch([provider("a", async () => [])]);
  assert.deepEqual(await empty.search("nothing"), []);
  const broken = new WebSearch([
    provider("a", async () => {
      throw new Error("x");
    }),
  ]);
  await assert.rejects(() => broken.search("q"), /all search providers failed/u);
  await assert.rejects(() => new WebSearch([]).search("q"), /no search provider/u);
});
