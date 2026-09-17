// Read one page into something a language model can use: title, description,
// any schema.org products, and the readable text (truncated).

import type { WebFetcher } from "./fetcher.js";
import { extractLdProducts, extractTitle, htmlToText, metaContent } from "./html.js";
import { cleanMarketTitle, enrichCard, extractPriceHint, parseAmazonAsin, parseBolProductId } from "./market.js";
import type { PageSummary, ProductCard } from "./types.js";

export interface ReadOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 3500;

export async function readPage(fetcher: WebFetcher, url: string, opts: ReadOptions = {}): Promise<PageSummary> {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const r = await fetcher.fetchPage(url);
  if (r.blocked) {
    return {
      url,
      finalUrl: r.finalUrl,
      via: r.via,
      blocked: true,
      blockReason: r.blockReason ?? "blocked",
      title: null,
      description: null,
      products: [],
      text: "",
      truncated: false,
    };
  }

  if (r.via === "jina") {
    const text = r.body;
    const products: ProductCard[] = [];
    const asin = parseAmazonAsin(r.finalUrl) ?? parseAmazonAsin(url);
    const bolId = parseBolProductId(r.finalUrl) ?? parseBolProductId(url);
    const price = extractPriceHint(text.slice(0, 40_000));
    if ((asin || bolId) && r.title) {
      products.push({
        store: asin ? "amazon" : "bol",
        id: asin ?? bolId,
        title: cleanMarketTitle(r.title),
        url: r.finalUrl,
        price,
        currency: "EUR",
        priceSource: price === null ? null : "page",
        brand: null,
        image: null,
        availability: null,
        rating: null,
        reviews: null,
        snippet: null,
      });
    }
    return {
      url,
      finalUrl: r.finalUrl,
      via: r.via,
      blocked: false,
      title: r.title ?? null,
      description: null,
      products,
      text: text.slice(0, maxChars),
      truncated: text.length > maxChars,
    };
  }

  const html = r.body;
  const isHtml = /html/iu.test(r.contentType) || /<html|<body|<div/iu.test(html.slice(0, 2000));
  const text = isHtml ? htmlToText(html) : html;
  const title = isHtml ? (metaContent(html, "og:title") ?? extractTitle(html)) : null;
  const products: ProductCard[] = isHtml ? extractLdProducts(html, r.finalUrl).slice(0, 12) : [];

  // Marketplace product pages carry no JSON-LD; build one card from the page
  // itself (Amazon's offscreen price, bol's structured data, or a euro amount).
  if (isHtml && products.length === 0) {
    const asin = parseAmazonAsin(r.finalUrl) ?? parseAmazonAsin(url);
    const bolId = parseBolProductId(r.finalUrl) ?? parseBolProductId(url);
    if (asin || bolId) {
      const card: ProductCard = {
        store: asin ? "amazon" : "bol",
        id: asin ?? bolId,
        title: cleanMarketTitle(title ?? ""),
        url: r.finalUrl,
        price: null,
        currency: "EUR",
        priceSource: null,
        brand: null,
        image: metaContent(html, "og:image"),
        availability: null,
        rating: null,
        reviews: null,
        snippet: null,
      };
      enrichCard(card, html, text, title);
      if (card.title.length > 3) products.push(card);
    }
  }

  return {
    url,
    finalUrl: r.finalUrl,
    via: r.via,
    blocked: false,
    title,
    description: isHtml ? (metaContent(html, "description") ?? metaContent(html, "og:description")) : null,
    products,
    text: text.slice(0, maxChars),
    truncated: text.length > maxChars,
  };
}
