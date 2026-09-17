// Small, dependency-free HTML helpers: entity decoding, text extraction,
// meta tags and JSON-LD product cards. Good enough for search-result pages
// and product pages; it is not a browser.

import type { ProductCard } from "./types.js";

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", hellip: "…", ndash: "–", mdash: "—",
  laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", middot: "·", bull: "•", rsquo: "’",
  lsquo: "‘", rdquo: "”", ldquo: "“", eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iuml: "ï", icirc: "î", ouml: "ö",
  ocirc: "ô", oacute: "ó", uuml: "ü", ucirc: "û", uacute: "ú", auml: "ä", agrave: "à", aacute: "á", acirc: "â",
  ccedil: "ç", iacute: "í", ntilde: "ñ", szlig: "ß", oslash: "ø", aring: "å", aelig: "æ",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+[0-9]*);/giu, (m, ent: string) => {
    if (ent.startsWith("#")) {
      const hex = ent[1]?.toLowerCase() === "x";
      const code = hex ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[ent.toLowerCase()] ?? m;
  });
}

/** Strip tags to readable text. Blocks become newlines, list items get bullets. */
export function htmlToText(html: string): string {
  const s = html
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, " ")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer|ul|ol|table|blockquote|pre|dd|dt|option|figcaption)\s*>/giu, "\n")
    .replace(/<li\b[^>]*>/giu, "• ")
    .replace(/<\/t[dh]\s*>/giu, " | ")
    .replace(/<[^>]+>/gu, " ");
  return decodeEntities(s)
    .replace(/[ \t \r]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/iu);
  if (!m?.[1]) return null;
  const t = decodeEntities(m[1]).replace(/\s+/gu, " ").trim();
  return t || null;
}

/** `<meta name=... content=...>` or `<meta property=... content=...>`, attribute order agnostic. */
export function metaContent(html: string, key: string): string | null {
  const re = /<meta\b[^>]*>/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const nameMatch = tag.match(/\b(?:name|property|itemprop)\s*=\s*["']([^"']+)["']/iu);
    if (!nameMatch || nameMatch[1]!.toLowerCase() !== key.toLowerCase()) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/iu);
    if (content?.[1]) return decodeEntities(content[1]).trim();
  }
  return null;
}

export function canonicalUrl(html: string): string | null {
  const m = html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/iu);
  const href = m?.[0].match(/\bhref\s*=\s*["']([^"']+)["']/iu);
  return href?.[1] ? decodeEntities(href[1]) : null;
}

/** Every parsed `<script type="application/ld+json">` block; invalid JSON is skipped. */
export function extractJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/giu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = (m[1] ?? "").replace(/^\s*<!\[CDATA\[|\]\]>\s*$/gu, "").trim();
    if (!raw) continue;
    try {
      out.push(JSON.parse(raw));
    } catch {
      // Some sites emit invalid JSON (trailing commas, comments). Skip it.
    }
  }
  return out;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const typeOf = (o: Obj): string[] => {
  const t = o["@type"];
  return Array.isArray(t) ? t.map(String) : t ? [String(t)] : [];
};

function* walk(node: unknown, depth = 0): Generator<Obj> {
  if (depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walk(n, depth + 1);
    return;
  }
  if (!isObj(node)) return;
  yield node;
  for (const key of ["@graph", "mainEntity", "itemListElement", "item", "hasVariant", "isRelatedTo"]) {
    if (key in node) yield* walk(node[key], depth + 1);
  }
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(",", ".").replace(/[^\d.]/gu, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (Array.isArray(v)) return str(v[0]);
  if (isObj(v)) {
    if (typeof v.name === "string") return v.name.trim() || null;
    if (typeof v.url === "string") return v.url;
    if (typeof v.contentUrl === "string") return v.contentUrl;
  }
  return null;
}

function offerOf(o: Obj): { price: number | null; currency: string | null; availability: string | null; url: string | null } {
  const offers = o.offers;
  const first = Array.isArray(offers) ? offers.find(isObj) : isObj(offers) ? offers : null;
  if (!first) return { price: null, currency: null, availability: null, url: null };
  const spec = isObj(first.priceSpecification) ? first.priceSpecification : null;
  const price = num(first.price) ?? num(first.lowPrice) ?? (spec ? num(spec.price) : null);
  const availability = typeof first.availability === "string" ? first.availability.replace(/^https?:\/\/schema\.org\//u, "") : null;
  return {
    price,
    currency: typeof first.priceCurrency === "string" ? first.priceCurrency : null,
    availability,
    url: typeof first.url === "string" ? first.url : null,
  };
}

/** schema.org Product nodes found in the page, normalised to cards. */
export function extractLdProducts(html: string, pageUrl: string): ProductCard[] {
  const cards: ProductCard[] = [];
  const seen = new Set<string>();
  for (const block of extractJsonLd(html)) {
    for (const node of walk(block)) {
      if (!typeOf(node).some((t) => /product/iu.test(t))) continue;
      const title = str(node.name);
      if (!title) continue;
      const offer = offerOf(node);
      const rawUrl = offer.url ?? (typeof node.url === "string" ? node.url : pageUrl);
      const url = absoluteUrl(rawUrl, pageUrl);
      const key = `${title}|${url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const agg = isObj(node.aggregateRating) ? node.aggregateRating : null;
      const reviews = agg ? num(agg.reviewCount ?? agg.ratingCount) : null;
      cards.push({
        store: storeKeyOf(url),
        id: str(node.sku) ?? str(node.productID) ?? str(node.gtin13) ?? null,
        title,
        url,
        price: offer.price,
        currency: offer.currency ?? "EUR",
        priceSource: offer.price === null ? null : "jsonld",
        brand: str(node.brand),
        image: str(node.image),
        availability: offer.availability,
        rating: agg ? num(agg.ratingValue) : null,
        reviews: reviews === null ? null : Math.round(reviews),
        snippet: typeof node.description === "string" ? node.description.replace(/\s+/gu, " ").slice(0, 200) : null,
      });
    }
  }
  return cards;
}

export function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "").toLowerCase();
  } catch {
    return "";
  }
}

/** "bol" / "amazon" for the marketplaces, otherwise the bare host. */
export function storeKeyOf(url: string): string {
  const h = hostOf(url);
  if (h === "bol.com" || h.endsWith(".bol.com")) return "bol";
  if (/(^|\.)amazon\.[a-z.]+$/u.test(h)) return "amazon";
  return h;
}
