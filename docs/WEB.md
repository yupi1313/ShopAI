# Web layer: internet search, page reads, bol.com and Amazon.nl

Packages: `@shopai/connector-web` (transport + parsing) and
`@shopai/capability-web` (agent tools). Built 2026-09-16.

The goal: the bot can search the internet for a specific product the family
asks for, read the pages it finds, and find products on bol.com and
Amazon.nl through their **web versions**, with no account, no automation of
a logged-in session and nothing bought. Amazon gets an official add-to-cart
link; everything else gets product links.

## What the server can and cannot reach (recon 2026-09-16)

All tests from the Hetzner box (Nuremberg, datacenter IP), plain HTTPS with
a Chrome user agent unless noted.

| Target | From the box | Notes |
| --- | --- | --- |
| `html.duckduckgo.com/html/?q=` | 200, real results | IPv4 only (IPv6 resets). Intermittent connection resets and a 202 "anomaly" challenge under load. Ads are tagged and dropped. |
| `bing.com/search` | 200 but **junk** | Serves unrelated results to the datacenter IP. Not used. |
| Brave Search API | reachable (422 without key) | Free tier 2000 queries/month. The reliable option. |
| serper.dev | reachable (403 without key) | Google results, free tier 2500. |
| `r.jina.ai/<url>` (Jina Reader) | 200 **only with a non-browser user agent** | A Chrome UA gets a Cloudflare challenge. Reads Coolblue, Jumbo and **Amazon product pages** (price present as `"priceAmount"`); Amazon search pages 503; bol.com blocks Jina's IPs ("IP address is blocked"); www.ah.nl returns an Akamai block page. `s.jina.ai` search needs a key. |
| `www.bol.com` | **403** everywhere | Also 403 for curl from a home IP; the block is fingerprint plus IP. Product URLs carry the id (`/p/<slug>/<id>/`). |
| `www.amazon.nl` | **503 / "automated access" page** | Search page 503, product page 200 with the bot wall. From a home IP curl gets the real search page (ASINs in `data-asin`). |
| `www.ah.nl` | **403 Akamai "Access Denied"** | Even the home page. From a home IP the home page loads but `/gql` is 403 for non-browser clients. The mobile API (`api.ah.nl`) keeps working from the box. |
| `coolblue.nl`, `jumbo.com` | 200 | Coolblue has JSON-LD `ItemList` / `Product`; Jumbo has none. |
| `mediamarkt.nl`, `tweakers.net`, `beslist.nl`, `mojeek.com`, `search.brave.com` (HTML) | 403 / captcha / 429 | Not usable. |

Conclusion: **direct scraping of AH, bol.com and Amazon.nl from the server
is dead on arrival.** Discovery works through search engines; page reads
work through Jina for Amazon; bol.com and the AH website need a residential
egress or a browser at home.

## How it is built

`WebFetcher` (`fetcher.ts`) tries transports in order and never throws for
a block, it reports `blocked: true` with the reason:

1. **direct**: HTTPS from the server with browser-like headers, 3 MB cap,
   one request at a time per host with a 1 s gap.
2. **proxy**: the same request through `WEB_PROXY_URL` for hosts listed in
   `WEB_PROXY_HOSTS` (default `bol.com,amazon.nl`). Off until a residential
   proxy is configured.
3. **jina**: `https://r.jina.ai/<url>` with a plain user agent, JSON mode,
   plain-text output. `JINA_API_KEY` raises the rate limit.

A host that refuses a transport goes into a 20-minute cooldown for that
transport, and successful pages are cached for 30 minutes. Block detection
covers HTTP 401/403/407/429/503 plus the known challenge pages (Cloudflare,
Akamai, Amazon's automated-access page, "IP address is blocked", captcha
titles, DuckDuckGo's anomaly page).

`WebSearch` (`search.ts`) runs a provider chain in the order of
`WEB_SEARCH_PROVIDERS`; keyed providers without a key are skipped. The
first provider with results wins, failures are logged and skipped, results
are cached for an hour. Providers: `brave`, `serper`, `jina`, `duckduckgo`.

`market.ts`: `site:bol.com` / `site:amazon.nl` searches, product ids parsed
from URLs (bol: `/p/<slug>/<digits>/`; Amazon: `/dp/<ASIN>`), snippets
scanned for a euro amount, then the top two cards enriched by reading the
page (JSON-LD offer price, Amazon's `a-offscreen` price, or the
`"priceAmount"` blob in Jina's text). `amazonCartLink()` builds
`https://www.amazon.nl/gp/aws/cart/add.html?ASIN.1=…&Quantity.1=…`.

`html.ts`: entity decoding, tag stripping, meta tags, JSON-LD extraction
with `@graph` / `ItemList` walking into normalised product cards.

## Agent tools

| Tool | What it does |
| --- | --- |
| `web_search(query, site?, limit?)` | Internet search, titles + links + snippets. |
| `web_read(url, maxChars?)` | Title, description, JSON-LD products, readable text. `blocked: true` when the site refuses. |
| `market_search(query, store?, limit?)` | bol.com and/or Amazon.nl product cards with links; price when known and where it came from. |
| `amazon_cart_link(items)` | Official multi-item add-to-cart link. |

All four are `sideEffect: "none"`: nothing needs the confirm gate because
nothing changes a basket. The system prompt tells the model to give links,
to say when a price is unknown, and never to invent prices.

## Configuration

See `.env.example` and the table in [OPERATIONS.md](./OPERATIONS.md). With
no keys at all the bot still works: DuckDuckGo for search (flaky), Jina
unauthenticated for reads. A Brave key is the one-line upgrade that makes
search reliable.

## Roadmap: getting real access to the web versions

The three Dutch sites block the server's IP, not the bot's behaviour. The
options, cheapest first:

1. **Search API keys** (Brave, Serper): reliable discovery; no change to
   page access. Do this first.
2. **Residential proxy** in `WEB_PROXY_URL`: unlocks bol.com and Amazon.nl
   page reads (prices, availability) with zero code changes. Paid, per GB.
   Does not give logged-in basket writes.
3. **Home browser relay** (`apps/relay`, not built yet): a small Node +
   Playwright worker on a home machine (PC, NAS, Raspberry Pi) with a
   persistent Chrome profile where a family member logs in to ah.nl,
   bol.com and amazon.nl once. It connects **outbound** to the server
   (WebSocket through the tunnel, shared secret) and executes jobs such
   as "add product 193679 x2 to the AH basket" by calling the site's own
   web API from inside the real browser session. Residential IP, real
   browser fingerprint, real cookies: this passes Akamai and bol's checks,
   and it is the only route to AH basket **writes** while the app API's
   write endpoint stays gated (see [STORE-AH.md](./STORE-AH.md)). Costs:
   the machine must be on when the family asks; otherwise the bot degrades
   to links. Every write stays behind the confirm gate.
4. **Amazon Creators API**: clean catalogue search if the family opens an
   Amazon Associates account. Optional.
