// Polite page fetcher with three transports, tried in order:
//   direct  - plain HTTPS from the server (works for cooperative sites)
//   proxy   - the same request through WEB_PROXY_URL for hosts that block
//             datacenter IPs (bol.com, amazon.nl); a residential egress
//   jina    - Jina Reader (r.jina.ai) fetches with its own browsers and
//             returns text; reads Amazon product pages the server cannot
// A host that refuses us goes into a cooldown so we stop hammering it, and
// results are cached in memory. One request at a time per host with a gap.

import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
import { hostOf } from "./html.js";
import { silentLogger, WebError, type FetchResult, type FetchVia, type WebLogger } from "./types.js";

export type FetchImpl = typeof undiciFetch;

export interface FetcherOptions {
  /** HTTP(S) proxy URL used for `proxyHosts` (a residential egress). */
  proxyUrl?: string | null;
  /** Hosts (bare, without www) that go through the proxy when one is configured. */
  proxyHosts?: string[];
  /** Use Jina Reader as the fallback transport. Default true. */
  jinaEnabled?: boolean;
  jinaApiKey?: string | null;
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Minimum gap between two requests to the same host. */
  minGapMs?: number;
  /** How long a blocked host is skipped for the transport that failed. */
  blockCooldownMs?: number;
  cacheTtlMs?: number;
  log?: WebLogger;
  fetchImpl?: FetchImpl;
  now?: () => number;
}

export interface FetchPageOptions {
  /** auto = direct/proxy then jina; direct = never jina; jina = only jina. */
  mode?: "auto" | "direct" | "jina";
  noCache?: boolean;
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
/** Jina must NOT see a browser UA: its Cloudflare front challenges those. */
const JINA_USER_AGENT = "ShopAI/0.1 (+https://shop.chern.nl)";
const JINA_BASE = "https://r.jina.ai/";

const BLOCK_STATUS = new Set([401, 403, 407, 429, 503]);
const BLOCK_MARKERS: Array<[RegExp, string]> = [
  [/api-services-support@amazon/iu, "amazon automated-access page"],
  [/IP address [\d.]+ is blocked|temporarily blocked due to possible abuse/iu, "ip blocked"],
  [/<title>\s*Just a moment/iu, "cloudflare challenge"],
  [/<title>\s*Access Denied/iu, "akamai access denied"],
  [/Powered and protected by[\s\S]{0,80}Akamai/iu, "akamai block page"],
  [/<title>[^<]*(Robot Check|captcha)/iu, "captcha"],
  [/Type the characters you see in this image/iu, "captcha"],
  [/Pardon Our Interruption/iu, "bot wall"],
  [/anomaly-modal|bots use DuckDuckGo too/iu, "duckduckgo anomaly"],
];

export function detectBlock(status: number, body: string): string | null {
  if (BLOCK_STATUS.has(status)) return `http ${status}`;
  const head = body.slice(0, 8000);
  for (const [re, why] of BLOCK_MARKERS) if (re.test(head)) return why;
  return null;
}

interface CacheEntry {
  at: number;
  value: FetchResult;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class WebFetcher {
  private readonly opts: Required<Omit<FetcherOptions, "proxyUrl" | "jinaApiKey" | "fetchImpl" | "log" | "now">> & {
    proxyUrl: string | null;
    jinaApiKey: string | null;
  };
  private readonly fetchImpl: FetchImpl;
  private readonly log: WebLogger;
  private readonly now: () => number;
  private readonly proxyDispatcher: Dispatcher | null;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly cooldown = new Map<string, number>();
  private readonly hostChain = new Map<string, Promise<void>>();
  private readonly lastAt = new Map<string, number>();

  constructor(options: FetcherOptions = {}) {
    this.opts = {
      proxyUrl: options.proxyUrl?.trim() || null,
      proxyHosts: (options.proxyHosts ?? ["bol.com", "amazon.nl"]).map((h) => h.replace(/^www\./u, "").toLowerCase()),
      jinaEnabled: options.jinaEnabled ?? true,
      jinaApiKey: options.jinaApiKey?.trim() || null,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      timeoutMs: options.timeoutMs ?? 20_000,
      maxBytes: options.maxBytes ?? 3_000_000,
      minGapMs: options.minGapMs ?? 1000,
      blockCooldownMs: options.blockCooldownMs ?? 20 * 60_000,
      cacheTtlMs: options.cacheTtlMs ?? 30 * 60_000,
    };
    this.fetchImpl = options.fetchImpl ?? undiciFetch;
    this.log = options.log ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.proxyDispatcher = this.opts.proxyUrl ? new ProxyAgent(this.opts.proxyUrl) : null;
  }

  get hasProxy(): boolean {
    return this.proxyDispatcher !== null;
  }

  /** Which transport a direct-ish request to this host would use. */
  transportFor(url: string): "direct" | "proxy" {
    const host = hostOf(url);
    const proxied = this.proxyDispatcher && this.opts.proxyHosts.some((h) => host === h || host.endsWith(`.${h}`));
    return proxied ? "proxy" : "direct";
  }

  /** Fetch a page, falling back across transports. Never throws for a block: check `blocked`. */
  async fetchPage(url: string, options: FetchPageOptions = {}): Promise<FetchResult> {
    const mode = options.mode ?? "auto";
    const key = `${mode}:${url}`;
    if (!options.noCache) {
      const hit = this.cache.get(key);
      if (hit && this.now() - hit.at < this.opts.cacheTtlMs) return hit.value;
    }
    const host = hostOf(url);
    if (!host) throw new WebError(`not a valid http(s) url: ${url}`, "config");

    let result: FetchResult | null = null;
    let lastErr: unknown = null;
    const skipped: string[] = [];

    if (mode !== "jina") {
      const via = this.transportFor(url);
      if (this.inCooldown(via, host)) {
        skipped.push(via);
        this.log.debug({ host, via }, "web: host in cooldown, skipping transport");
      } else {
        try {
          result = await this.gate(host, () => this.direct(url, via));
          if (result.blocked) this.markBlocked(via, host, result.blockReason ?? "blocked");
        } catch (err) {
          lastErr = err;
          this.log.warn({ err: String(err), host, via }, "web: transport failed");
        }
      }
    }

    if ((result === null || result.blocked) && mode !== "direct" && this.opts.jinaEnabled) {
      if (this.inCooldown("jina", host)) {
        skipped.push("jina");
        this.log.debug({ host }, "web: jina in cooldown for host");
      } else {
        try {
          const viaJina = await this.gate(`jina:${host}`, () => this.jina(url));
          if (viaJina.blocked) this.markBlocked("jina", host, viaJina.blockReason ?? "blocked");
          // Prefer a readable jina result over a blocked direct one; when both
          // are blocked, keep the direct result but report both reasons.
          if (!viaJina.blocked || result === null) result = viaJina;
          else result = { ...result, blockReason: `${result.blockReason ?? "blocked"}; ${viaJina.blockReason ?? "jina: blocked"}` };
        } catch (err) {
          lastErr = err;
          this.log.warn({ err: String(err), host }, "web: jina failed");
        }
      }
    }

    if (result === null) {
      if (skipped.length > 0 && lastErr === null) {
        // Every usable transport is cooling down after an earlier block: that
        // is a block, not a network failure, and it is not worth caching.
        return {
          url,
          finalUrl: url,
          status: 0,
          via: skipped[0] as FetchVia,
          contentType: "",
          body: "",
          blocked: true,
          blockReason: `${skipped.join("+")}: host blocked us earlier; cooling down`,
        };
      }
      const msg = lastErr instanceof Error ? lastErr.message : "no transport could fetch the page";
      throw new WebError(msg, "network");
    }
    this.remember(key, result);
    return result;
  }

  private inCooldown(via: string, host: string): boolean {
    const until = this.cooldown.get(`${via}:${host}`);
    return until !== undefined && until > this.now();
  }

  private markBlocked(via: string, host: string, why: string): void {
    this.cooldown.set(`${via}:${host}`, this.now() + this.opts.blockCooldownMs);
    this.log.info({ host, via, why }, "web: host blocked us; cooling down");
  }

  private remember(key: string, value: FetchResult): void {
    if (this.cache.size >= 300) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: this.now(), value });
  }

  /** Serialise requests per host and keep a minimum gap between them. */
  private async gate<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.hostChain.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const chained = prev.then(() => mine);
    this.hostChain.set(host, chained);
    await prev;
    try {
      const wait = this.opts.minGapMs - (this.now() - (this.lastAt.get(host) ?? 0));
      if (wait > 0) await sleep(wait);
      return await fn();
    } finally {
      this.lastAt.set(host, this.now());
      release();
      if (this.hostChain.get(host) === chained) this.hostChain.delete(host);
    }
  }

  private browserHeaders(): Record<string, string> {
    return {
      "user-agent": this.opts.userAgent,
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "nl-NL,nl;q=0.9,en;q=0.8",
      "upgrade-insecure-requests": "1",
      "sec-fetch-dest": "document",
      "sec-fetch-mode": "navigate",
      "sec-fetch-site": "none",
    };
  }

  private async direct(url: string, via: "direct" | "proxy"): Promise<FetchResult> {
    const res = await this.fetchImpl(url, {
      headers: this.browserHeaders(),
      redirect: "follow",
      signal: AbortSignal.timeout(this.opts.timeoutMs),
      ...(via === "proxy" && this.proxyDispatcher ? { dispatcher: this.proxyDispatcher } : {}),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res, this.opts.maxBytes, contentType);
    const why = detectBlock(res.status, body);
    return {
      url,
      finalUrl: res.url || url,
      status: res.status,
      via,
      contentType,
      body,
      blocked: why !== null,
      ...(why ? { blockReason: `${via}: ${why}` } : {}),
    };
  }

  private async jina(url: string): Promise<FetchResult> {
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": JINA_USER_AGENT,
      "x-return-format": "text",
      "x-timeout": "25",
    };
    if (this.opts.jinaApiKey) headers.authorization = `Bearer ${this.opts.jinaApiKey}`;
    const res = await this.fetchImpl(`${JINA_BASE}${url}`, {
      headers,
      signal: AbortSignal.timeout(this.opts.timeoutMs + 20_000),
    });
    const raw = await res.text();
    if (res.status === 401 || res.status === 402 || res.status === 429) {
      throw new WebError(`jina reader refused: http ${res.status}`, "provider");
    }
    let data: { title?: string; url?: string; text?: string; description?: string; warning?: string } = {};
    try {
      const parsed = JSON.parse(raw) as { data?: typeof data };
      data = parsed.data ?? {};
    } catch {
      data = { text: raw };
    }
    const text = (data.text ?? "").trim();
    const why = res.ok ? detectBlock(200, text) ?? (text.length < 40 ? "empty page" : null) : `http ${res.status}`;
    return {
      url,
      finalUrl: data.url || url,
      status: res.status,
      via: "jina",
      contentType: "text/plain",
      body: text,
      blocked: why !== null,
      ...(why ? { blockReason: `jina: ${why}` } : {}),
      ...(data.title ? { title: data.title } : {}),
    };
  }
}

/** Read at most `maxBytes` of the body and decode with the charset from the content type. */
async function readCapped(res: Awaited<ReturnType<FetchImpl>>, maxBytes: number, contentType: string): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), Math.min(total, maxBytes));
  const charset = contentType.match(/charset=([\w-]+)/iu)?.[1]?.toLowerCase() ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString("utf8");
  }
}

export type { FetchResult, FetchVia };
