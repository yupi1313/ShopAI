// bol.com and Amazon.nl through the public web: product discovery via the
// search-provider chain with a site: filter, ids parsed from product URLs,
// optional enrichment by reading the product page (price, real title), and
// the official Amazon add-to-cart link. No account, no automation of a
// logged-in session, nothing is bought.

import { extractLdProducts, extractTitle, hostOf, htmlToText, metaContent } from "./html.js";
import type { WebFetcher } from "./fetcher.js";
import type { WebSearch } from "./search.js";
import { silentLogger, type ProductCard, type SearchResult, type WebLogger } from "./types.js";

export type MarketStore = "bol" | "amazon";

export const MARKET_SITES: Record<MarketStore, string> = { bol: "bol.com", amazon: "amazon.nl" };
export const MARKET_NAMES: Record<MarketStore, string> = { bol: "bol.com", amazon: "Amazon.nl" };

/** `/nl/nl/p/<slug>/<id>/` (also `/nl/be/p/...`); ids are 10+ digits. */
export function parseBolProductId(url: string): string | null {
  if (!/(^|\.)bol\.com$/u.test(hostOf(url))) return null;
  const m = url.match(/\/p\/[^/?#]*\/(\d{8,})\/?(?:[?#]|$)/u) ?? url.match(/\/p\/(\d{8,})\/?(?:[?#]|$)/u);
  return m?.[1] ?? null;
}

/** `/dp/ASIN`, `/gp/product/ASIN`, `/product/ASIN`, `/gp/aw/d/ASIN`. */
export function parseAmazonAsin(url: string): string | null {
  if (!/(^|\.)amazon\.[a-z.]+$/u.test(hostOf(url))) return null;
  const m = url.match(/\/(?:dp|gp\/product|gp\/aw\/d|product)\/([A-Z0-9]{10})(?:[/?#]|$)/u);
  return m?.[1] ?? null;
}

export function bolProductLink(id: string): string {
  return `https://www.bol.com/nl/nl/p/-/${id}/`;
}

export function amazonProductLink(asin: string): string {
  return `https://www.amazon.nl/dp/${asin}`;
}

/**
 * Amazon's documented multi-item add-to-cart form URL. Whoever opens it (on
 * their own logged-in phone) gets the items in their cart and checks out
 * themselves. `associateTag` only matters for affiliate attribution.
 */
export function amazonCartLink(items: Array<{ asin: string; qty?: number }>, associateTag?: string | null): string {
  const params = new URLSearchParams();
  items.forEach((it, i) => {
    params.set(`ASIN.${i + 1}`, it.asin.toUpperCase());
    params.set(`Quantity.${i + 1}`, String(Math.max(1, Math.min(99, Math.round(it.qty ?? 1)))));
  });
  if (associateTag) params.set("AssociateTag", associateTag);
  return `https://www.amazon.nl/gp/aws/cart/add.html?${params.toString()}`;
}

/** Strip the marketplace suffixes search engines show in titles. */
export function cleanMarketTitle(title: string): string {
  return title
    .replace(/\s*[|\-–:]\s*(bol\.com|bol|Bol\.com|Bol)\s*$/u, "")
    .replace(/\s*:\s*Amazon\.nl\s*:.*$/u, "")
    .replace(/\s*[|\-–]\s*Amazon\.nl.*$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Best-effort price from page text. Amazon's page (via Jina) carries a
 * `"priceAmount":9.99` blob; otherwise the first euro amount near a price
 * word, else the first euro amount at all. Returns null rather than guess
 * when nothing looks like a price.
 */
export function extractPriceHint(text: string): number | null {
  const amount = text.match(/"priceAmount"\s*:\s*(\d+(?:\.\d+)?)/u);
  if (amount?.[1]) return Number(amount[1]);
  const euro = /€\s?(\d{1,4})[.,](\d{2})(?!\d)|(?<![\d.,])(\d{1,4}),(\d{2})\s?€/gu;
  const near = text.match(/(?:prijs|price|nu|kosten)[^€\d]{0,40}€\s?(\d{1,4})[.,](\d{2})/iu);
  if (near?.[1] && near[2]) return Number(`${near[1]}.${near[2]}`);
  const m = euro.exec(text);
  if (!m) return null;
  const whole = m[1] ?? m[3];
  const cents = m[2] ?? m[4];
  return whole && cents ? Number(`${whole}.${cents}`) : null;
}

export function productIdFor(store: MarketStore, url: string): string | null {
  return store === "bol" ? parseBolProductId(url) : parseAmazonAsin(url);
}

/** Turn search hits into product cards; non-product pages (category lists, help) are dropped. */
export function cardsFromResults(store: MarketStore, results: SearchResult[]): ProductCard[] {
  const out: ProductCard[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const id = productIdFor(store, r.url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const snippetPrice = extractPriceHint(r.snippet);
    out.push({
      store,
      id,
      title: cleanMarketTitle(r.title) || r.title,
      url: store === "amazon" ? amazonProductLink(id) : r.url.split("?")[0]!,
      price: snippetPrice,
      currency: "EUR",
      priceSource: snippetPrice === null ? null : "snippet",
      brand: null,
      image: null,
      availability: null,
      rating: null,
      reviews: null,
      snippet: r.snippet || null,
    });
  }
  return out;
}

export interface MarketDeps {
  search: WebSearch;
  fetcher: WebFetcher;
  log?: WebLogger;
}

export interface MarketSearchOptions {
  query: string;
  store: MarketStore;
  limit?: number;
  /** How many top cards to enrich by reading their page. 0 disables. */
  enrich?: number;
}

export interface MarketSearchResult {
  store: MarketStore;
  cards: ProductCard[];
  /** Set when the site refused page reads; discovery still worked via search. */
  pagesBlocked: boolean;
  provider: string | null;
}

/** Search one marketplace and enrich the top cards with page data where the site lets us. */
export async function searchMarketplace(deps: MarketDeps, opts: MarketSearchOptions): Promise<MarketSearchResult> {
  const log = deps.log ?? silentLogger;
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const hits = await deps.search.search(opts.query, { site: MARKET_SITES[opts.store], limit: Math.max(limit * 3, 10) });
  const cards = cardsFromResults(opts.store, hits).slice(0, limit);
  const provider = hits[0]?.source ?? null;
  let pagesBlocked = false;
  const enrich = Math.min(cards.length, opts.enrich ?? 2);
  for (let i = 0; i < enrich; i++) {
    const card = cards[i]!;
    try {
      const page = await deps.fetcher.fetchPage(card.url);
      if (page.blocked) {
        pagesBlocked = true;
        log.debug({ store: opts.store, url: card.url, why: page.blockReason }, "market: page read blocked");
        break; // the rest of the same host will be blocked too
      }
      enrichCard(card, page.via === "jina" ? null : page.body, page.body, page.title ?? null);
    } catch (err) {
      log.warn({ err: String(err), url: card.url }, "market: page read failed");
      break;
    }
  }
  return { store: opts.store, cards, pagesBlocked, provider };
}

/** Fill price/title/brand from a fetched product page (HTML or plain text). */
export function enrichCard(card: ProductCard, html: string | null, text: string, knownTitle: string | null): void {
  if (html) {
    const ld = extractLdProducts(html, card.url).find((p) => p.price !== null) ?? extractLdProducts(html, card.url)[0];
    if (ld) {
      if (ld.price !== null) {
        card.price = ld.price;
        card.currency = ld.currency;
        card.priceSource = "jsonld";
      }
      card.brand = card.brand ?? ld.brand;
      card.image = card.image ?? ld.image;
      card.availability = card.availability ?? ld.availability;
      card.rating = card.rating ?? ld.rating;
      card.reviews = card.reviews ?? ld.reviews;
      if (ld.title && ld.title.length > 3) card.title = ld.title;
    }
    if (card.priceSource !== "jsonld") {
      // Amazon's buy box: <span class="a-offscreen">€9,99</span>
      const off = html.match(/class="a-offscreen">\s*€\s?(\d{1,4})[.,](\d{2})/u);
      const p = off ? Number(`${off[1]}.${off[2]}`) : extractPriceHint(htmlToText(html).slice(0, 20_000));
      if (p !== null) {
        card.price = p;
        card.priceSource = "page";
      }
    }
    const title = metaContent(html, "og:title") ?? extractTitle(html);
    if (title && card.title.length < 8) card.title = cleanMarketTitle(title);
    return;
  }
  const p = extractPriceHint(text.slice(0, 40_000));
  if (p !== null) {
    card.price = p;
    card.priceSource = "page";
  }
  if (knownTitle) {
    const t = cleanMarketTitle(knownTitle);
    if (t.length > 3) card.title = t;
  }
}
