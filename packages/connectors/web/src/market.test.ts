import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  amazonCartLink,
  cardsFromResults,
  cleanMarketTitle,
  enrichCard,
  extractPriceHint,
  parseAmazonAsin,
  parseAmazonSearchHtml,
  parseBolProductId,
} from "./market.js";

test("parseAmazonSearchHtml reads ASIN, title, price and sponsored flag from a real listing", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(here, "fixtures", "amazon_search.html"), "utf8");
  const cards = parseAmazonSearchHtml(html);
  assert.ok(cards.length >= 3, `expected cards, got ${cards.length}`);
  for (const c of cards) {
    assert.match(c.id!, /^[A-Z0-9]{10}$/u);
    assert.ok(c.title.length > 10, c.title);
    assert.equal(c.url, `https://www.amazon.nl/dp/${c.id}`);
    assert.equal(c.store, "amazon");
  }
  const iniu = cards.find((c) => c.id === "B0BR3L78XN")!;
  assert.match(iniu.title, /^INIU 240W USB-C kabel/u);
  assert.equal(iniu.price, 9.65);
  assert.equal(iniu.priceSource, "page");
  assert.ok(cards.filter((c) => c.price !== null).length >= 2);
  // organic before sponsored
  const firstSponsored = cards.findIndex((c) => c.sponsored);
  const lastOrganic = cards.map((c) => c.sponsored).lastIndexOf(false);
  assert.ok(firstSponsored === -1 || lastOrganic < firstSponsored);
});

test("parseBolProductId reads product pages only", () => {
  assert.equal(parseBolProductId("https://www.bol.com/nl/nl/p/belkin-usb-c-naar-usb-c-kabel-2m-zwart/9200000132189684/"), "9200000132189684");
  assert.equal(parseBolProductId("https://www.bol.com/nl/nl/p/-/9200000132189684/?bltgh=abc"), "9200000132189684");
  assert.equal(parseBolProductId("https://www.bol.com/nl/nl/l/usb-sticks/7117/"), null);
  assert.equal(parseBolProductId("https://www.coolblue.nl/p/x/9200000132189684/"), null);
});

test("parseAmazonAsin handles dp and gp/product forms", () => {
  assert.equal(parseAmazonAsin("https://www.amazon.nl/JSAUX-USB-C-Kabel/dp/B07BBLTX96/ref=sr_1_1?keywords=x"), "B07BBLTX96");
  assert.equal(parseAmazonAsin("https://www.amazon.nl/gp/product/B07BBLTX96"), "B07BBLTX96");
  assert.equal(parseAmazonAsin("https://www.amazon.nl/s?k=usb+c"), null);
  assert.equal(parseAmazonAsin("https://www.bol.com/dp/B07BBLTX96"), null);
});

test("amazonCartLink builds the official multi-item form URL", () => {
  const link = amazonCartLink([{ asin: "b07bbltx96", qty: 2 }, { asin: "B07PCLY6LT" }], "tag-21");
  const u = new URL(link);
  assert.equal(u.origin + u.pathname, "https://www.amazon.nl/gp/aws/cart/add.html");
  assert.equal(u.searchParams.get("ASIN.1"), "B07BBLTX96");
  assert.equal(u.searchParams.get("Quantity.1"), "2");
  assert.equal(u.searchParams.get("ASIN.2"), "B07PCLY6LT");
  assert.equal(u.searchParams.get("Quantity.2"), "1");
  assert.equal(u.searchParams.get("AssociateTag"), "tag-21");
  assert.equal(new URL(amazonCartLink([{ asin: "B07BBLTX96" }])).searchParams.has("AssociateTag"), false);
});

test("extractPriceHint prefers structured amounts, then price words, then any euro amount", () => {
  assert.equal(extractPriceHint('...buybox":[{"displayPrice":"€9.99","priceAmount":9.99,'), 9.99);
  assert.equal(extractPriceHint("Levering morgen. Prijs: € 12,95 incl. btw"), 12.95);
  assert.equal(extractPriceHint("Vanaf 5,00 € per stuk"), 5);
  assert.equal(extractPriceHint("Korting 20% tot 31 december"), null);
  assert.equal(extractPriceHint(""), null);
});

test("cleanMarketTitle strips marketplace suffixes", () => {
  assert.equal(cleanMarketTitle("Belkin USB-C naar USB-C kabel - 2m - zwart | bol"), "Belkin USB-C naar USB-C kabel - 2m - zwart");
  assert.equal(cleanMarketTitle("2 Meter Lange USB C Kabel - Bol"), "2 Meter Lange USB C Kabel");
  assert.equal(cleanMarketTitle("JSAUX USB-C Cable : Amazon.nl: Electronics & Photo"), "JSAUX USB-C Cable");
});

test("cardsFromResults keeps product pages, dedupes ids and reads snippet prices", () => {
  const cards = cardsFromResults("bol", [
    { title: "A | bol", url: "https://www.bol.com/nl/nl/p/a/9200000000000001/?x=1", snippet: "Nu € 19,99", source: "t" },
    { title: "List", url: "https://www.bol.com/nl/nl/l/kabels/123/", snippet: "", source: "t" },
    { title: "A again", url: "https://www.bol.com/nl/nl/p/a/9200000000000001/", snippet: "", source: "t" },
    { title: "B", url: "https://www.bol.com/nl/nl/p/b/9200000000000002/", snippet: "geen prijs", source: "t" },
  ]);
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.id, "9200000000000001");
  assert.equal(cards[0]!.title, "A");
  assert.equal(cards[0]!.url, "https://www.bol.com/nl/nl/p/a/9200000000000001/");
  assert.equal(cards[0]!.price, 19.99);
  assert.equal(cards[0]!.priceSource, "snippet");
  assert.equal(cards[1]!.price, null);
  const amz = cardsFromResults("amazon", [{ title: "X : Amazon.nl: Y", url: "https://www.amazon.nl/x/dp/B07BBLTX96/ref=1", snippet: "", source: "t" }]);
  assert.equal(amz[0]!.url, "https://www.amazon.nl/dp/B07BBLTX96");
  assert.equal(amz[0]!.title, "X");
});

test("enrichCard uses JSON-LD, then Amazon's offscreen price, then text", () => {
  const base = () => cardsFromResults("amazon", [{ title: "Kabel", url: "https://www.amazon.nl/dp/B07BBLTX96", snippet: "", source: "t" }])[0]!;
  const ld = base();
  enrichCard(ld, `<script type="application/ld+json">{"@type":"Product","name":"Echte naam","brand":"JSAUX","offers":{"price":"11.49","priceCurrency":"EUR"}}</script>`, "", null);
  assert.equal(ld.price, 11.49);
  assert.equal(ld.priceSource, "jsonld");
  assert.equal(ld.brand, "JSAUX");
  assert.equal(ld.title, "Echte naam");

  const off = base();
  enrichCard(off, `<html><body><span class="a-offscreen">€9,99</span></body></html>`, "", null);
  assert.equal(off.price, 9.99);
  assert.equal(off.priceSource, "page");

  const txt = base();
  enrichCard(txt, null, 'blah "priceAmount":7.5 blah', "Nieuwe titel : Amazon.nl: Elektronica");
  assert.equal(txt.price, 7.5);
  assert.equal(txt.title, "Nieuwe titel");
});
