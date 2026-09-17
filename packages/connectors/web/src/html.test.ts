import test from "node:test";
import assert from "node:assert/strict";
import { decodeEntities, extractLdProducts, extractTitle, htmlToText, metaContent, storeKeyOf } from "./html.js";
import { readPage } from "./reader.js";
import type { WebFetcher } from "./fetcher.js";

test("decodeEntities handles named, decimal and hex entities", () => {
  assert.equal(decodeEntities("&euro;9,99 &amp; &#0183; &#x41; &nbsp;x &unknown;"), "€9,99 & · A  x &unknown;");
});

test("htmlToText drops scripts/styles and keeps block structure", () => {
  const html = `<html><head><title>T</title><style>.a{}</style></head><body>
    <script>var x = "<p>no</p>";</script>
    <h1>Hello</h1><p>One &amp; two</p><ul><li>a</li><li>b</li></ul>
    <table><tr><td>1</td><td>2</td></tr></table></body></html>`;
  const text = htmlToText(html);
  assert.ok(!text.includes("var x"));
  assert.ok(!text.includes(".a{}"));
  assert.match(text, /Hello\nOne & two\n• a\n• b/u);
  assert.match(text, /1 \| 2 \|/u);
});

test("extractLdProducts reads Product nodes incl. @graph, offers arrays and ratings", () => {
  const html = `<html><head>
  <script type="application/ld+json">{"@context":"https://schema.org","@graph":[
    {"@type":"BreadcrumbList"},
    {"@type":"Product","name":"Belkin USB-C kabel 2m","brand":{"@type":"Brand","name":"Belkin"},"sku":"9200000132189684",
     "image":["https://img/x.jpg"],"url":"/nl/nl/p/belkin/9200000132189684/",
     "offers":[{"@type":"Offer","price":"12,99","priceCurrency":"EUR","availability":"https://schema.org/InStock"}],
     "aggregateRating":{"@type":"AggregateRating","ratingValue":"4.6","reviewCount":"120"}}
  ]}</script>
  <script type="application/ld+json">not json</script>
  <script type="application/ld+json">{"@type":"Product","name":"No offer product"}</script>
  </head></html>`;
  const cards = extractLdProducts(html, "https://www.bol.com/nl/nl/s/?searchtext=x");
  assert.equal(cards.length, 2);
  const [first, second] = cards;
  assert.equal(first!.title, "Belkin USB-C kabel 2m");
  assert.equal(first!.brand, "Belkin");
  assert.equal(first!.id, "9200000132189684");
  assert.equal(first!.price, 12.99);
  assert.equal(first!.currency, "EUR");
  assert.equal(first!.priceSource, "jsonld");
  assert.equal(first!.availability, "InStock");
  assert.equal(first!.rating, 4.6);
  assert.equal(first!.reviews, 120);
  assert.equal(first!.image, "https://img/x.jpg");
  assert.equal(first!.url, "https://www.bol.com/nl/nl/p/belkin/9200000132189684/");
  assert.equal(first!.store, "bol");
  assert.equal(second!.price, null);
  assert.equal(second!.priceSource, null);
});

test("metaContent is attribute-order agnostic and extractTitle trims", () => {
  const html = `<head><meta content="Og &amp; Title" property="og:title"><meta name="description" content="Desc"><title>
     Page   Title </title></head>`;
  assert.equal(metaContent(html, "og:title"), "Og & Title");
  assert.equal(metaContent(html, "description"), "Desc");
  assert.equal(metaContent(html, "missing"), null);
  assert.equal(extractTitle(html), "Page Title");
});

test("storeKeyOf maps marketplaces and keeps other hosts", () => {
  assert.equal(storeKeyOf("https://www.bol.com/nl/nl/p/x/123/"), "bol");
  assert.equal(storeKeyOf("https://www.amazon.nl/dp/B07BBLTX96"), "amazon");
  assert.equal(storeKeyOf("https://www.coolblue.nl/product/1.html"), "coolblue.nl");
  assert.equal(storeKeyOf("not a url"), "");
});

test("readPage summarises an HTML page with products and a jina text page", async () => {
  const html = `<html><head><title>Shop</title><meta property="og:title" content="Kabel kopen"><meta name="description" content="Beste kabels">
    <script type="application/ld+json">{"@type":"Product","name":"Kabel A","offers":{"price":"5.50","priceCurrency":"EUR"}}</script>
    </head><body><nav>menu</nav><main><h1>Kabel A</h1><p>Lange tekst</p></main></body></html>`;
  const fake = {
    fetchPage: async (url: string) =>
      url.includes("amazon")
        ? { url, finalUrl: url, status: 200, via: "jina", contentType: "text/plain", body: 'Title\n"priceAmount":9.99 In stock', blocked: false, title: "JSAUX kabel : Amazon.nl: Electronics" }
        : { url, finalUrl: url, status: 200, via: "direct", contentType: "text/html; charset=utf-8", body: html, blocked: false },
  } as unknown as WebFetcher;

  const page = await readPage(fake, "https://www.coolblue.nl/x", { maxChars: 20 });
  assert.equal(page.title, "Kabel kopen");
  assert.equal(page.description, "Beste kabels");
  assert.equal(page.products.length, 1);
  assert.equal(page.products[0]!.price, 5.5);
  assert.equal(page.text.length, 20);
  assert.equal(page.truncated, true);

  const amz = await readPage(fake, "https://www.amazon.nl/dp/B07BBLTX96");
  assert.equal(amz.via, "jina");
  assert.equal(amz.products.length, 1);
  assert.equal(amz.products[0]!.id, "B07BBLTX96");
  assert.equal(amz.products[0]!.price, 9.99);
  assert.equal(amz.products[0]!.title, "JSAUX kabel");
});
