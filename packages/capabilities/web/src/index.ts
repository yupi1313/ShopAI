// Web capability: lets the agent search the internet, read pages, and find
// products on bol.com and Amazon.nl through their public web pages. Nothing
// here logs in, buys, or changes a basket; Amazon gets an official
// add-to-cart link the user opens on their own phone.

import { z } from "zod";
import { defineTool, type Capability, type Logger, type ToolContext } from "@shopai/core";
import {
  MARKET_NAMES,
  WebFetcher,
  WebSearch,
  amazonCartLink,
  createSearchProviders,
  readPage,
  searchMarketplace,
  type MarketStore,
  type ProductCard,
} from "@shopai/connector-web";

export interface WebCapabilityConfig {
  log: Logger;
  /** Provider order, e.g. ["brave", "serper", "jina", "duckduckgo"]. */
  searchProviders?: string[];
  braveApiKey?: string | null;
  serperApiKey?: string | null;
  jinaApiKey?: string | null;
  /** Residential proxy for the marketplace hosts (optional). */
  proxyUrl?: string | null;
  proxyHosts?: string[];
  amazonAssociateTag?: string | null;
}

export interface WebCapability extends Capability {
  search: WebSearch;
  fetcher: WebFetcher;
}

function money(p: number | null, currency = "EUR"): string | null {
  if (p === null) return null;
  return currency === "EUR" ? `€${p.toFixed(2)}` : `${p.toFixed(2)} ${currency}`;
}

function cardView(c: ProductCard) {
  return {
    store: c.store,
    id: c.id,
    title: c.title,
    price: money(c.price, c.currency),
    priceSource: c.priceSource,
    brand: c.brand ?? undefined,
    rating: c.rating ?? undefined,
    reviews: c.reviews ?? undefined,
    availability: c.availability ?? undefined,
    url: c.url,
    snippet: c.snippet ? c.snippet.slice(0, 160) : undefined,
  };
}

export function createWebCapability(cfg: WebCapabilityConfig): WebCapability {
  const log = cfg.log.child({ mod: "web" });
  const providers = createSearchProviders({
    order: cfg.searchProviders,
    braveApiKey: cfg.braveApiKey,
    serperApiKey: cfg.serperApiKey,
    jinaApiKey: cfg.jinaApiKey,
    log,
  });
  const search = new WebSearch(providers, { log });
  const fetcher = new WebFetcher({
    proxyUrl: cfg.proxyUrl,
    proxyHosts: cfg.proxyHosts,
    jinaApiKey: cfg.jinaApiKey,
    timeoutMs: 15_000,
    log,
  });
  log.info({ providers: search.providerNames, proxy: fetcher.hasProxy }, "web capability ready");

  const webSearch = defineTool({
    name: "web_search",
    description:
      "Search the internet. Use for 'find X online', 'which shop sells X', 'what does X cost', product research, comparisons, or any question you cannot answer from memory. Returns titles, links and snippets; follow up with web_read on a promising link when details matter. Optional site restricts to one domain (e.g. coolblue.nl).",
    schema: z.object({
      query: z.string().min(2).max(200),
      site: z.string().max(80).optional().describe("bare domain to restrict to, e.g. coolblue.nl"),
      limit: z.number().int().min(1).max(10).optional(),
    }),
    sideEffect: "none",
    async handler(args) {
      const results = await search.search(args.query, { site: args.site?.replace(/^www\./u, ""), limit: args.limit ?? 6 });
      return {
        provider: results[0]?.source ?? null,
        count: results.length,
        results: results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet.slice(0, 220) })),
      };
    },
  });

  const webRead = defineTool({
    name: "web_read",
    description:
      "Open a web page and return its title, any product data (name, price, availability) and the readable text, truncated. Use after web_search to check a price or detail. If the site blocks automated access you get blocked:true; then give the user the link instead of guessing.",
    schema: z.object({
      url: z.string().url().max(1000),
      maxChars: z.number().int().min(300).max(6000).optional(),
    }),
    sideEffect: "none",
    async handler(args) {
      const page = await readPage(fetcher, args.url, { maxChars: args.maxChars ?? 2500 });
      if (page.blocked) {
        return { blocked: true, reason: page.blockReason, hint: "This site refuses automated reads from our server. Share the link with the user; do not invent its content." };
      }
      return {
        title: page.title,
        description: page.description,
        via: page.via,
        products: page.products.slice(0, 8).map(cardView),
        text: page.text,
        truncated: page.truncated,
      };
    },
  });

  const marketSearch = defineTool({
    name: "market_search",
    description:
      "Find products on bol.com and/or Amazon.nl (non-grocery: electronics, household, toys, books...). Returns product cards with id, title, price when known, and a link. Prices come from search snippets or a page read and can be missing or stale: say so and always give the link. bol.com blocks our server, so bol cards usually have a link but no price.",
    schema: z.object({
      query: z.string().min(2).max(160),
      store: z.enum(["bol", "amazon", "both"]).optional().describe("default both"),
      limit: z.number().int().min(1).max(8).optional(),
    }),
    sideEffect: "none",
    async handler(args, ctx: ToolContext) {
      const stores: MarketStore[] = args.store === "bol" ? ["bol"] : args.store === "amazon" ? ["amazon"] : ["bol", "amazon"];
      const limit = args.limit ?? 4;
      const out = await Promise.all(
        stores.map(async (store) => {
          try {
            const r = await searchMarketplace({ search, fetcher, log: ctx.log }, { query: args.query, store, limit, enrich: 2 });
            return {
              store,
              name: MARKET_NAMES[store],
              provider: r.provider,
              pagesBlocked: r.pagesBlocked || undefined,
              products: r.cards.map(cardView),
            };
          } catch (err) {
            return { store, name: MARKET_NAMES[store], error: err instanceof Error ? err.message : "search failed", products: [] };
          }
        }),
      );
      return {
        stores: out,
        note: "For Amazon, amazon_cart_link builds one tap-to-add link for chosen ASINs. For bol.com, share the product link; the user adds it in the bol app.",
      };
    },
  });

  const cartLink = defineTool({
    name: "amazon_cart_link",
    description:
      "Build Amazon.nl's official add-to-cart link for one or more products (ASINs from market_search). The user opens it on their phone, the items land in their own Amazon cart, and they check out themselves. Nothing is bought by you.",
    schema: z.object({
      items: z
        .array(z.object({ asin: z.string().regex(/^[A-Za-z0-9]{10}$/u), qty: z.number().int().min(1).max(99).optional() }))
        .min(1)
        .max(20),
    }),
    sideEffect: "none",
    async handler(args) {
      return { link: amazonCartLink(args.items, cfg.amazonAssociateTag), items: args.items.length, note: "Tap the link, then check out in Amazon yourself." };
    },
  });

  async function promptFragment(): Promise<string> {
    return [
      "Web: you can search the internet (web_search), read pages (web_read) and find products on bol.com and Amazon.nl (market_search).",
      "Use them when someone asks to find, compare or price a product that is not groceries, or asks something you do not know. Keep answers short: the best 2 or 3 options, each with price (or 'price unknown') and its link.",
      "Marketplace prices are hints and may be stale; never invent a price, rating or stock. For Amazon offer amazon_cart_link so the user can add items with one tap; for bol.com share the product link. You never buy anything.",
    ].join(" ");
  }

  return {
    name: "web",
    tools: [webSearch, webRead, marketSearch, cartLink] as Capability["tools"],
    promptFragment,
    search,
    fetcher,
  };
}
