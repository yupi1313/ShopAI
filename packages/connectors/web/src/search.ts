// Web search behind a provider chain. Keyed APIs first (reliable from a
// datacenter IP), the keyless DuckDuckGo HTML endpoint as the last resort.
// The chain returns the first provider that answers with results.

import { fetch as undiciFetch } from "undici";
import { decodeEntities, htmlToText } from "./html.js";
import { DEFAULT_USER_AGENT, type FetchImpl } from "./fetcher.js";
import { silentLogger, WebError, type SearchResult, type WebLogger } from "./types.js";

export interface SearchOptions {
  limit?: number;
  /** Restrict to one site, e.g. "bol.com". */
  site?: string;
}

export interface SearchProvider {
  readonly name: string;
  search(query: string, opts: Required<SearchOptions>): Promise<SearchResult[]>;
}

const DEFAULT_LIMIT = 8;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function withSite(query: string, site: string): string {
  return site ? `site:${site} ${query}` : query;
}

function clean(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/gu, "")).replace(/\s+/gu, " ").trim();
}

// ---------------------------------------------------------------- DuckDuckGo

/** Parse the html.duckduckgo.com result page. Ads are dropped. Exported for tests. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const flat = html.replace(/[\r\n]+/gu, " ");
  const out: SearchResult[] = [];
  for (const block of flat.split(/<div class="result results_links/u).slice(1)) {
    if (/result--ad|badge--ad/u.test(block.slice(0, 400))) continue;
    const a = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/u);
    if (!a) continue;
    const href = decodeEntities(a[1]!);
    const uddg = href.match(/[?&]uddg=([^&]+)/u);
    let url = href;
    if (uddg?.[1]) {
      try {
        url = decodeURIComponent(uddg[1]);
      } catch {
        url = uddg[1];
      }
    }
    if (url.startsWith("//")) url = `https:${url}`;
    if (/duckduckgo\.com\/y\.js/u.test(url)) continue; // ad click-through
    const s = block.match(/<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/u);
    out.push({ title: clean(a[2]!), url, snippet: s ? clean(s[1]!) : "", source: "duckduckgo" });
  }
  return out;
}

export function isDuckDuckGoAnomaly(status: number, html: string): boolean {
  return status === 202 || /anomaly-modal|bots use DuckDuckGo too|challenge-form/u.test(html.slice(0, 20_000));
}

export class DuckDuckGoProvider implements SearchProvider {
  readonly name = "duckduckgo";
  constructor(
    private readonly fetchImpl: FetchImpl = undiciFetch,
    private readonly userAgent: string = DEFAULT_USER_AGENT,
  ) {}

  async search(query: string, opts: Required<SearchOptions>): Promise<SearchResult[]> {
    const q = withSite(query, opts.site);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=nl-nl`;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(1500);
      try {
        const res = await this.fetchImpl(url, {
          headers: {
            "user-agent": this.userAgent,
            accept: "text/html,application/xhtml+xml",
            "accept-language": "nl-NL,nl;q=0.9,en;q=0.8",
          },
          signal: AbortSignal.timeout(15_000),
        });
        const html = await res.text();
        if (isDuckDuckGoAnomaly(res.status, html)) throw new WebError("duckduckgo rate-limited this IP", "provider");
        if (!res.ok) throw new WebError(`duckduckgo http ${res.status}`, "provider");
        return parseDuckDuckGoHtml(html).slice(0, opts.limit);
      } catch (err) {
        lastErr = err;
        if (err instanceof WebError && err.kind === "provider") throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new WebError("duckduckgo unreachable", "network");
  }
}

// --------------------------------------------------------------------- Brave

export class BraveProvider implements SearchProvider {
  readonly name = "brave";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl = undiciFetch,
  ) {}

  async search(query: string, opts: Required<SearchOptions>): Promise<SearchResult[]> {
    const q = withSite(query, opts.site);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(q)}&count=${Math.min(20, opts.limit)}&country=NL&search_lang=nl&ui_lang=nl-NL`;
    const res = await this.fetchImpl(url, {
      headers: { accept: "application/json", "x-subscription-token": this.apiKey },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new WebError(`brave http ${res.status}`, "provider");
    const json = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (json.web?.results ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: clean(r.title ?? ""), url: r.url!, snippet: clean(r.description ?? ""), source: "brave" }))
      .slice(0, opts.limit);
  }
}

// -------------------------------------------------------------------- Serper

export class SerperProvider implements SearchProvider {
  readonly name = "serper";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl = undiciFetch,
  ) {}

  async search(query: string, opts: Required<SearchOptions>): Promise<SearchResult[]> {
    const res = await this.fetchImpl("https://google.serper.dev/search", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": this.apiKey },
      body: JSON.stringify({ q: withSite(query, opts.site), gl: "nl", hl: "nl", num: Math.min(20, opts.limit) }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new WebError(`serper http ${res.status}`, "provider");
    const json = (await res.json()) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> };
    return (json.organic ?? [])
      .filter((r) => r.link)
      .map((r) => ({ title: clean(r.title ?? ""), url: r.link!, snippet: clean(r.snippet ?? ""), source: "serper" }))
      .slice(0, opts.limit);
  }
}

// ---------------------------------------------------------------- Jina search

export class JinaSearchProvider implements SearchProvider {
  readonly name = "jina";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchImpl = undiciFetch,
  ) {}

  async search(query: string, opts: Required<SearchOptions>): Promise<SearchResult[]> {
    const url = `https://s.jina.ai/?q=${encodeURIComponent(withSite(query, opts.site))}&gl=NL&hl=nl`;
    const res = await this.fetchImpl(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": "ShopAI/0.1 (+https://shop.chern.nl)",
        "x-respond-with": "no-content",
      },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new WebError(`jina search http ${res.status}`, "provider");
    const json = (await res.json()) as { data?: Array<{ title?: string; url?: string; description?: string }> };
    return (json.data ?? [])
      .filter((r) => r.url)
      .map((r) => ({ title: clean(r.title ?? ""), url: r.url!, snippet: clean(r.description ?? ""), source: "jina" }))
      .slice(0, opts.limit);
  }
}

// --------------------------------------------------------------------- chain

export interface SearchChainConfig {
  /** Provider order, e.g. ["brave", "serper", "jina", "duckduckgo"]. Unknown names are ignored, keyless keyed providers are skipped. */
  order?: string[];
  braveApiKey?: string | null;
  serperApiKey?: string | null;
  jinaApiKey?: string | null;
  fetchImpl?: FetchImpl;
  userAgent?: string;
  log?: WebLogger;
  cacheTtlMs?: number;
}

export const DEFAULT_PROVIDER_ORDER = ["brave", "serper", "jina", "duckduckgo"];

export function createSearchProviders(cfg: SearchChainConfig): SearchProvider[] {
  const f = cfg.fetchImpl ?? undiciFetch;
  const out: SearchProvider[] = [];
  for (const name of cfg.order ?? DEFAULT_PROVIDER_ORDER) {
    switch (name.trim().toLowerCase()) {
      case "brave":
        if (cfg.braveApiKey) out.push(new BraveProvider(cfg.braveApiKey, f));
        break;
      case "serper":
        if (cfg.serperApiKey) out.push(new SerperProvider(cfg.serperApiKey, f));
        break;
      case "jina":
        if (cfg.jinaApiKey) out.push(new JinaSearchProvider(cfg.jinaApiKey, f));
        break;
      case "duckduckgo":
      case "ddg":
        out.push(new DuckDuckGoProvider(f, cfg.userAgent));
        break;
      default:
        break;
    }
  }
  return out;
}

export class WebSearch {
  private readonly cache = new Map<string, { at: number; value: SearchResult[] }>();
  private readonly log: WebLogger;
  private readonly ttl: number;

  constructor(
    readonly providers: SearchProvider[],
    opts: { log?: WebLogger; cacheTtlMs?: number } = {},
  ) {
    this.log = opts.log ?? silentLogger;
    this.ttl = opts.cacheTtlMs ?? 60 * 60_000;
  }

  get providerNames(): string[] {
    return this.providers.map((p) => p.name);
  }

  /** First provider with results wins. Throws only when every provider failed. */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const opts: Required<SearchOptions> = { limit: options.limit ?? DEFAULT_LIMIT, site: options.site ?? "" };
    const key = `${opts.site}|${opts.limit}|${query.trim().toLowerCase()}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.value;

    if (this.providers.length === 0) throw new WebError("no search provider configured", "config");
    const errors: string[] = [];
    let sawEmpty = false;
    for (const p of this.providers) {
      try {
        const results = await p.search(query, opts);
        if (results.length > 0) {
          this.remember(key, results);
          return results;
        }
        sawEmpty = true;
        this.log.debug({ provider: p.name, query }, "web search: no results");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${p.name}: ${msg}`);
        this.log.warn({ provider: p.name, err: msg }, "web search: provider failed");
      }
    }
    if (sawEmpty) {
      this.remember(key, []);
      return [];
    }
    throw new WebError(`all search providers failed (${errors.join("; ")})`, "provider");
  }

  private remember(key: string, value: SearchResult[]): void {
    if (this.cache.size >= 500) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: Date.now(), value });
  }
}

export { htmlToText };
