/** One hit from a web search provider. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Provider that produced it: brave | serper | jina | duckduckgo. */
  source: string;
}

/** A product as read from a page (JSON-LD) or a marketplace search. Store-agnostic. */
export interface ProductCard {
  /** "bol", "amazon", or the bare host for any other shop. */
  store: string;
  /** bol product id, Amazon ASIN, or null when unknown. */
  id: string | null;
  title: string;
  url: string;
  price: number | null;
  currency: string;
  /** Where the price came from. */
  priceSource: "jsonld" | "page" | "snippet" | null;
  brand: string | null;
  image: string | null;
  availability: string | null;
  rating: number | null;
  reviews: number | null;
  snippet: string | null;
}

export type FetchVia = "direct" | "proxy" | "jina";

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  via: FetchVia;
  contentType: string;
  /** Raw HTML for direct/proxy, plain text for jina. */
  body: string;
  /** True when the site refused automated access (403/429/503 or a challenge page). */
  blocked: boolean;
  blockReason?: string;
  /** Page title when the transport already knows it (jina). */
  title?: string;
}

export interface PageSummary {
  url: string;
  finalUrl: string;
  via: FetchVia | null;
  blocked: boolean;
  blockReason?: string;
  title: string | null;
  description: string | null;
  products: ProductCard[];
  /** Readable text, truncated to the caller's budget. */
  text: string;
  truncated: boolean;
}

export class WebError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "blocked" | "provider" | "config",
  ) {
    super(message);
    this.name = "WebError";
  }
}

/** Minimal logger surface (pino-compatible), so the connector stays dependency-light. */
export interface WebLogger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export const silentLogger: WebLogger = { debug() {}, info() {}, warn() {} };
