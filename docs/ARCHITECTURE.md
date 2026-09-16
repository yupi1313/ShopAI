# ShopAI — architecture and module plan

Family assistant that plans meals and shopping, keeps a shared list, fills
the **Albert Heijn** basket, and finds non-grocery products on **bol.com**
and **Amazon.nl**. Controlled from Telegram (group and private chats) and a
small web page. Thinks with **ZillaAGI (ZAGI)**, the in-house LLM. Runs on
the Hetzner CPX22 (`ubuntu-4gb-nbg1-1`, 116.203.224.204) next to an existing
project that must not be touched. Built to grow: more stores, non-grocery
purchases, later trip planning.

Status: **v2, decisions confirmed on 2026-09-16** (section 1). Remaining
open items are in section 16.

---

## 1. Decision log

| Date | Decision |
| --- | --- |
| 2026-09-16 | Grocery store is **Albert Heijn** (Netherlands). Login is account + password; exact flow verified in Phase 0 recon (section 8). |
| 2026-09-16 | **bol.com** and **Amazon.nl** are supported for **non-grocery product search** (find, compare, link). Basket filling there is out of scope for now. |
| 2026-09-16 | **The bot never pays.** It fills the AH basket and posts a checkout link; a human pays. |
| 2026-09-16 | **Purchase history is monitored** (AH online orders and, if the API allows, in-store receipts) so "buy pasta" resolves to the brand and size the family actually buys. |
| 2026-09-16 | ZAGI credentials: **reuse the shared key** already used by Oddzilla and other projects. |
| 2026-09-16 | Telegram: **group chats and private chats** both supported. A **web page** is the second interface. |
| 2026-09-16 | Stack: **TypeScript everywhere, Postgres** (recommendation accepted pending your reply, rationale in section 4). |
| 2026-09-16 | Git initialised locally on `main`; remote to be created by you. |

---

## 2. Goals and non-goals

**Goals**

- Conversational planning: "what do we cook this week", "add milk", "we're
  out of eggs", "plan groceries for 4 days", "what did we buy last time".
- One shared household list every member sees and edits, from Telegram or
  the web page.
- Fill the AH basket from the list with the **right** products, learned from
  what the family really buys.
- Find non-grocery items on bol.com and Amazon.nl: "find a 2 m USB-C cable",
  "cheapest air fryer under 100 euro", with links and a price comparison.
- Reminders: staples due, weekly planning nudge, basket left unpaid, bonus
  offers on things the family buys.
- Room to grow into new **capabilities** (trip planning, other shops)
  without touching the core.

**Non-goals (hard boundaries)**

- No payments, no checkout calls, no card or payment data, ever.
- No account creation, no CAPTCHA solving, no password typing by the bot.
  Store login is a human-driven flow in the admin's private chat.
- The model has no shell, no arbitrary HTTP, no file access. It only sees
  the tools each capability registers.

---

## 3. The LLM: ZAGI settings carried over from Oddzilla

Source of truth: `D:/AI/Oddzilla/services/api/src/lib/zagi/client.ts` and
`services/support-ai-bot/src/lmstudio.ts`. Verified facts:

| Setting | Value |
| --- | --- |
| Protocol | OpenAI-compatible `POST <base>/chat/completions` |
| `ZAGI_BASE_URL` | `https://llm.oddin.gg/v1` — **includes `/v1`**, nothing appended |
| `ZAGI_MODEL` | `glm-5.3-flash` — **must be pinned**; `/v1/models` lists several and the first entry is arbitrary |
| Auth | `Authorization: Bearer <ZAGI_API_KEY>` (shared key, same as Oddzilla) |
| Tool calling | OpenAI `tools` + `tool_choice: "auto"`, tool-result round trip **verified working** on glm-5.3-flash |
| Reasoning | Hidden reasoning tokens reported in `completion_tokens_details.reasoning_tokens`; about 1000 on a simple turn |
| Budget rule | Reasoning runs **before** visible text, so a small `max_tokens` returns **empty content with `finish_reason: "length"`**. Never treat that as "nothing to say". |
| Timeout | 180 s per call |
| Temperature | 0 for deterministic jobs (product matching), 0.2 to 0.4 for chat |

Client policy (in the client, not in callers):

- Chat turns: `max_tokens: 6000`; on empty + `length`, retry **once** at
  12000, then tell the user the model ran out of budget.
- Batch jobs (matching, planning): `max_tokens: 16000`, 25 items per request.
- Every call logged: prompt / completion / reasoning tokens, latency, finish
  reason, tools called, capability, chat (`llm_calls` table).
- Vision: not assumed. Photos of lists or receipts wait until the gateway
  exposes a vision model.

Expectation to set with the family: a turn with two or three tool rounds
takes **10 to 60 seconds**. The bot shows "typing", and edits a progress
message ("searching AH for 3 items...") instead of going silent.

---

## 4. Stack decision: TypeScript + Postgres

You asked which is better. For this project, with a web page confirmed and
growth expected, the answer is TypeScript with Postgres.

**TypeScript over Python**

- One language for bot, API, web page, adapters and shared types. With a
  web UI in the plan, Python would mean two languages and two toolchains.
- It is your house stack (Node 22, pnpm, Fastify, zod, pino, Drizzle). The
  ZAGI client and the container pattern port from Oddzilla unchanged.
- grammY is at least as good as aiogram; Playwright is first-class in Node,
  which matters for the marketplace adapters (section 8).
- Python's edge (data science, some scraping libraries) is not needed here.
  Where a Python AH wrapper exists, we read it for the endpoints and write
  the adapter in TS against AH's HTTP API directly.

**Postgres over SQLite**

- Two processes will touch the data (server and web, later workers). SQLite
  across containers is where it stops being simple.
- Growth: more capabilities, more tables, background jobs (`pg-boss` runs a
  job queue on Postgres, so no Redis needed), `pgvector` later for semantic
  product and recipe search.
- Cost is one more container at roughly 100 MB RAM, on a network with no
  published ports. Drizzle keeps the developer experience identical.

**Web page: React SPA served by the same server**, not a separate Next.js
process. A private family dashboard needs no SSR or SEO, and one process on
one loopback port keeps the shared box quiet. Next.js stays an option if
the web side ever grows into a real product.

---

## 5. High-level shape

```
Telegram (group + private)        Browser (family web page)
        |  long polling                    |  HTTPS via tunnel / Tailscale
        v                                  v
+--------------------------------------------------------------------+
|  shopai-server  (one Node 22 process, roles switchable by env)      |
|                                                                     |
|  adapters/telegram   grammY: allowlist, commands, keyboards, groups |
|  adapters/http       Fastify: /api for the SPA, /app static files   |
|                      \_____________  _____________/                 |
|                                    \/                               |
|  agent      LLM loop: prompt -> ZAGI -> tools -> reply              |
|             confirm gate for anything with side effects at a shop   |
|  capabilities                                                       |
|     grocery      list . staples . meal plan . recipes . AH basket   |
|     marketplace  bol.com + Amazon.nl search, compare, link          |
|     (trips)      later: same agent, same memory, new tools          |
|  connectors      ah . bol . amazon (HTTP first, Playwright fallback)|
|  learning        purchase history -> aliases, brands, cadences      |
|  scheduler       pg-boss jobs: nudges, imports, keepalive, backups  |
|  db              Postgres 16 via Drizzle                            |
+--------------------------------------------------------------------+
        |  HTTPS                  |  HTTPS                 |  HTTPS
        v                         v                        v
  ZAGI llm.oddin.gg/v1     api.ah.nl               bol.com / amazon.nl
```

**Capability modules** are the growth mechanism. Each capability is a
package that exports: tools (zod schema + handler), a prompt fragment,
scheduler jobs, web API routes, and migrations. The agent, memory, confirm
gate, Telegram and web layers are shared and know nothing about groceries.
Adding trip planning later is a new `capabilities/trips` package plus its
connectors (flights, hotels), nothing else changes.

---

## 6. Repository layout (pnpm workspaces)

```
shopai/
+-- apps/
|   +-- server/                 the one runtime process
|   |   +-- src/index.ts        boot: db, agent, capabilities, telegram, http, scheduler; graceful shutdown
|   |   +-- src/config.ts       zod env; ROLE=all|bot|api|worker for a later split
|   |   +-- src/telegram/       bot.ts auth.ts commands.ts keyboards.ts render.ts group.ts
|   |   +-- src/http/           fastify: /api/* routes from capabilities, /auth (magic link), /app (SPA)
|   |   +-- src/scheduler/      pg-boss registration of capability jobs + platform jobs (backup, keepalive)
|   +-- web/                    React + Vite SPA: list, basket, plan, history, settings; built into apps/server/public
+-- packages/
|   +-- core/                   agent loop, tool registry, confirm gate, memory, guardrails, capability contract
|   +-- llm/                    ZAGI client (tools, budgets, retries, call logging)
|   +-- db/                     Drizzle schema, migrations, typed queries
|   +-- connectors/
|   |   +-- ah/                 auth (token exchange + refresh), search, product, basket, orders, receipts, bonus
|   |   +-- bol/                search, product page extraction
|   |   +-- amazon/             search, product page extraction (Playwright profile)
|   |   +-- browser/            shared Playwright runner: one headless Chromium, persistent profiles, concurrency 1
|   +-- capabilities/
|   |   +-- grocery/            list, staples, plan, recipes, matcher, fill pipeline, AH tools, grocery jobs
|   |   +-- marketplace/        search + compare tools across bol/amazon, watchlist, price alerts
|   +-- learning/               purchase-history import, alias/brand model, cadence estimation
|   +-- types/                  shared DTOs between server and web
+-- docs/                       ARCHITECTURE.md, OPERATIONS.md, SERVER-INVENTORY.md, STORE-AH.md, MARKETPLACES.md
+-- deploy/                     docker-compose.yml, Dockerfile, Caddyfile or cloudflared config, backup script
+-- .env.example
```

---

## 7. Agent and tools

**Loop.** User message (Telegram or web) → build messages (system prompt +
capability fragments + rolling memory + user turn) → ZAGI → execute tool
calls → repeat up to 8 rounds → reply. One run per chat at a time; a second
message while a run is active is queued and acknowledged.

**System prompt** carries: household profile and facts, the member and their
language, date and timezone, a compact snapshot of the active list, the
rules (never invent prices, prefer previously bought products, ask when
unsure, answer in the user's language, confirm before any shop side effect).

**Confirm gate.** A tool marked `sideEffect: "shop"` never executes from
the model. The handler stores a `pending_action` and the reply carries a
Confirm / Cancel keyboard (or a button on the web page). A human tap runs
it. Pending actions expire after 15 minutes. List edits are not gated; the
reply shows the result with undo buttons.

**Tools by capability** (namespaced `grocery.*`, `market.*`, `home.*`):

| Tool | Side effect | Notes |
| --- | --- | --- |
| `home.remember_fact`, `home.members` | none | allergies, dislikes, brands, household size, who is who |
| `grocery.list_get / list_add / list_update / list_remove / list_mark_bought` | list only | many items per call; normalised qty and unit |
| `grocery.staples_get / staples_set` | list only | cadence in days, preferred product |
| `grocery.plan_get / plan_set / plan_to_list` | list only | plan-to-list explodes recipes, dedupes in code |
| `grocery.recipes_search / recipe_get / recipe_save` | none | household book first, web second |
| `grocery.ah_search(query, limit<=5)`, `grocery.ah_product(id)`, `grocery.ah_bonus(query)` | none | trimmed to name, brand, size, price, unit price, bonus flag, id |
| `grocery.basket_get` | none | items and total |
| `grocery.basket_add / basket_remove` | **shop** | model proposes, human confirms |
| `grocery.basket_fill_from_list` | **shop** | deterministic pipeline with full pick list before confirm |
| `grocery.purchases_recent(n)`, `grocery.purchases_of(item)` | none | "what did we buy last time", "which pasta do we buy" |
| `market.search(query, sites?)`, `market.product(url)`, `market.compare(query)` | none | bol.com and Amazon.nl cards with price, rating, link |
| `market.watch(url, target_price)` | none | price alert job |

Tool outputs are capped in size (top 5 products, trimmed fields) so prompts
stay small and reasoning budget goes to the decision, not to reading.

---

## 8. Connectors

### Albert Heijn (grocery, read + basket)

What is known from community clients (Home Assistant integrations and open
source wrappers), all to be **re-verified in Phase 0 recon** and written up
in `docs/STORE-AH.md`:

- **Host:** `https://api.ah.nl`, mobile-app API. Requests carry
  `x-application: AHWEBSHOP` and an app-like user agent.
- **Anonymous token:** `POST /mobile-auth/v1/auth/token/anonymous` with
  `{"clientId":"appie"}`. Enough for search and product detail.
- **Member login:** an OAuth-style code flow. The user opens
  `https://login.ah.nl/secure/oauth/authorize?client_id=appie&redirect_uri=appie://login-exit&response_type=code`
  in **their own browser**, logs in with their AH account and password, and
  is redirected to `appie://login-exit?code=...`. That URL cannot open on a
  desktop, so the user copies it and pastes it to the bot in a **private
  chat**. The bot exchanges the code at `POST /mobile-auth/v1/auth/token`
  for access and refresh tokens, and refreshes at
  `POST /mobile-auth/v1/auth/token/refresh`. **The bot never sees the
  password**, which is exactly the boundary we want. 2FA, if AH ever adds
  it, happens inside that browser step and needs no change on our side.
- **Search:** `GET /mobile-services/product/search/v2?query=...&size=...&sortOn=RELEVANCE`.
- **Product detail:** `GET /mobile-services/product/detail/v4/fir/{webshopId}`.
- **Receipts / purchase history:** `GET /mobile-services/v1/receipts` and
  `GET /mobile-services/v2/receipts/{transactionId}`. Community clients use
  this for **both online orders and in-store Bonuskaart purchases**. If that
  holds, brand learning covers the whole household's real buying, not just
  the online part.
- **Bonus offers:** `GET /mobile-services/bonuspage/v1/...`.
- **Basket:** the online-order basket endpoints are the least documented
  part; recon captures them from the app or web client. **Fallback if they
  prove fragile:** write to AH's own in-app list ("Mijn lijst",
  `/mobile-services/shoppinglist/v2/items`), which syncs to the AH app where
  one tap turns it into a basket. Degraded but still useful.

Rate discipline: cache search results per query for an hour, cache product
detail for a day, one request at a time per token, back off on 429. This is
a private API, so the connector is written to fail loud and idle gracefully
(store tools disappear from the model, list features keep working) rather
than retry blindly.

### bol.com and Amazon.nl (marketplace, search only)

Neither offers a usable public product API for this use case: Amazon's
Product Advertising API requires an affiliate account with qualifying
sales, and bol.com retired its open partner API. So both connectors read
the public web:

- **HTTP first.** Fetch the search and product pages with a browser-like
  client and extract structured data (JSON-LD, embedded state). bol.com is
  usually cooperative this way.
- **Playwright fallback.** Amazon.nl frequently challenges plain fetches.
  A single shared headless Chromium with a persistent profile, concurrency
  1, is used only when HTTP extraction fails. It costs 400 to 500 MB RAM
  while running and is killed when idle.
- **Output:** normalised product cards (title, price, unit price where
  present, rating, seller, delivery hint, deep link). `market.compare` runs
  both and lets the model present a short comparison.
- **Expectation:** marketplace scraping is best effort and will need
  occasional maintenance. The design isolates it so a broken extractor
  degrades to "could not read Amazon right now", never to a crash.
- **Not in scope now:** adding to bol or Amazon baskets. The deep link
  opens the product page; the human buys.

### Connector contracts

```ts
interface GroceryStore {
  readonly kind: "ah";
  beginLogin(): { instructions: string; authUrl: string };          // human opens this
  completeLogin(pastedRedirectUrl: string): Promise<void>;         // bot exchanges the code
  ensureSession(): Promise<void>;                                  // refresh; throws SessionExpired -> alert admin
  search(query: string, opts?: { limit?: number }): Promise<Product[]>;
  product(id: string): Promise<ProductDetail>;
  bonus(query?: string): Promise<BonusOffer[]>;
  basket(): Promise<Basket>;
  basketAdd(id: string, qty: number): Promise<Basket>;
  basketRemove(id: string, qty?: number): Promise<Basket>;
  purchases(since: Date): Promise<Purchase[]>;                     // orders + receipts, normalised
  checkoutUrl(): string;                                           // human opens this to pay
}

interface Marketplace {
  readonly kind: "bol" | "amazon_nl";
  search(query: string, opts?: { limit?: number; maxPrice?: number }): Promise<MarketProduct[]>;
  product(url: string): Promise<MarketProductDetail>;
}
```

---

## 9. Learning from purchase history

This is what turns "buy pasta" into the right pasta.

- **Import job** (nightly, plus on demand after a "did the order arrive?"
  answer): pull AH purchases since the last import, store normalised
  `purchases` and `purchase_items` (product id, name, brand, size, qty,
  price, in-store or online, date).
- **Alias and brand model.** For every normalised item name ("pasta",
  "melk", "koffie") keep the products bought, with counts and recency.
  Matching prefers, in order: an alias a human chose, the product most
  often bought recently, the same brand and size in a different variant,
  then the LLM's pick from search results.
- **Cadence.** From purchase dates estimate how often each staple is bought
  and when it is next due; feed the daily "staples due" nudge.
- **Bonus awareness.** When an item the family buys is on bonus this week,
  mention it once ("Your coffee is 2 for 1 this week, stock up?").
- **Explainability.** Every automatic pick carries a reason the reply can
  show: "Grand'Italia spaghetti 500 g, bought 6 times since June".
- **Feedback.** A "not this one" button on any picked product opens the
  candidate keyboard and writes the human choice as a locked alias.

---

## 10. Web page

- **What:** the same household seen from a browser: active list with
  checkboxes, basket status, weekly plan, purchase history and brand
  preferences, marketplace watchlist, member and store settings (admin).
- **How:** React + Vite SPA built into `apps/server/public`, served by
  Fastify under `/app`, API under `/api`. The SPA and the Telegram bot call
  the same capability services; the agent is reachable from the web too
  (a chat box), so the web page is a full second interface, not a viewer.
- **Auth:** **magic link from the bot.** `/web` in a private chat returns a
  one-time link valid 10 minutes; opening it sets a long-lived session
  cookie tied to that member. Identity stays anchored in the Telegram
  allowlist; no passwords, no Telegram Login Widget domain setup needed.
- **Exposure, in order of preference** (decided in Phase 0 once we see the
  box):
  1. **Cloudflare Tunnel** if you have a domain on Cloudflare: no inbound
     port, automatic HTTPS on a subdomain, optional Cloudflare Access on
     top. Zero interaction with the neighbour's ports.
  2. **Tailscale** for family devices only, no public exposure at all.
  3. **Own Caddy on a high port** with a DNS-01 certificate, if neither of
     the above and a domain exists. Still touches nothing of the neighbour.

---

## 11. Security and privacy

- **Allowlist** of Telegram user ids, deny by default. Roles `admin` and
  `member`. Unknown users get one refusal and are logged.
- **Group chats:** the bot acts on commands, mentions and replies to
  itself. Optional per-group "listen mode" for phrases like "we're out of
  X" can be switched on by the admin; default is off.
- **Secrets** (bot token, shared ZAGI key, Postgres password, session master
  key) live in `.env` with mode 600. AH tokens are encrypted at rest with
  libsodium secretbox under the master key.
- **Store login never passes a password through the bot** (section 8). The
  pasted redirect URL is deleted from the chat after the exchange.
- **No inbound network surface** for the bot; the web page is reached only
  through a tunnel, Tailscale, or our own Caddy on a port nobody else uses.
- **Prompt injection:** product titles, reviews, recipe pages and receipts
  are untrusted text flowing into the model. Every shop side effect is
  behind a human tap, and marketplace tools have no side effects at all.
- **Audit log** of every shop action, login, and membership change.
- **Data stays home:** Postgres on your box. Third parties that see content:
  Telegram, ZAGI (in-house), AH, and whatever bol.com or Amazon see from a
  search request.

---

## 12. Data model (Postgres 16, Drizzle)

| Table | Purpose |
| --- | --- |
| `households` | name, locale, currency, timezone, settings JSON |
| `members` | telegram_user_id, display name, role, language |
| `chats` | telegram_chat_id, household, kind private/group, listen mode |
| `web_sessions`, `magic_links` | web auth |
| `lists`, `list_items` | shared list; raw + normalised name, qty, unit, note, added_by, status `pending / in_basket / bought / removed`, product_ref, pick_reason |
| `staples` | name, cadence_days (estimated and manual), last_bought_at, preferred product |
| `meal_plans`, `meals` | week_start, day, slot, title, recipe_ref, servings |
| `recipes` | title, ingredients JSON, steps, source url, tags |
| `household_facts` | key/value memory with source and confidence |
| `store_accounts` | store kind, account label, **encrypted** tokens, expires_at, status |
| `products` | cached store products: store, id, name, brand, size, unit, price, unit price, bonus, image, fetched_at |
| `product_aliases` | household, normalised name, store, product id, source human/order/LLM, locked flag, score |
| `purchases`, `purchase_items` | imported AH history, online and in-store |
| `market_products`, `market_watches` | marketplace cards seen, price alerts |
| `conversations` | per chat and per web session: rolling turns, summary |
| `pending_actions` | proposed shop side effects awaiting confirm; expiry |
| `llm_calls` | tokens, latency, finish reason, tools, capability, chat |
| `audit_log` | actor, action, payload, timestamp |
| `pgboss.*` | job queue tables (managed by pg-boss) |

Backups: nightly `pg_dump -Fc` into `./backups`, keep 14, optional `rclone`
copy off-box.

---

## 13. Key flows

**Add to list.** "add 2l milk, bananas and our usual coffee" →
`grocery.list_add` with three normalised items, "usual coffee" resolved via
staples and aliases → list rendered with per-item buttons.

**Buy pasta.** "put pasta in the basket" → alias lookup finds the brand
bought 6 times → proposal "Grand'Italia spaghetti 500 g, 1.79" with Confirm
/ Other / Cancel → tap → `basketAdd` → item `in_basket` → running total.

**Fill basket.** "fill the basket" → pipeline over every pending item →
one message: picks with reasons and prices, items needing a choice with
keyboards, items not found → Confirm → adapter adds all → total and checkout
link → human pays in the AH app. Unpaid next morning → one reminder.

**Non-grocery.** "find a quiet 40 cm desk fan under 60 euro" →
`market.compare` → bol.com and Amazon.nl cards → short comparison with links
→ optional `market.watch` for a price drop.

**Weekly plan.** Sunday 18:00 nudge in the group → short conversation →
`plan_set` → `plan_to_list` → "Fill basket" button.

**Staples due and bonus.** Daily job: due staples and bonus offers on
regularly bought items → one combined message, Yes/No per item.

**Session expired.** AH refresh fails → admin alert → `/store login` →
paste the redirect URL → tokens renewed → store tools return.

---

## 14. Deployment on the shared CPX22 (2 vCPU, 4 GB, 80 GB)

Rule zero: **the other project is not touched, not restarted, not
re-proxied, and its ports are not reused.**

- **Phase 0 recon (read-only)** recorded in `docs/SERVER-INVENTORY.md`:
  `docker ps -a`, `docker compose ls`, running systemd services, `ss -ltnp`,
  `free -m`, `df -h`, `/opt /srv /home/*`, any reverse proxy and its config,
  unattended-upgrades status. Go / no-go on RAM headroom: we want at least
  1.2 GB free at rest for Postgres + server + occasional Playwright.
- **Stack:** `/opt/shopai/` with `docker-compose.yml`, `.env`, `data/`
  (Postgres volume), `backups/`, `profiles/` (Playwright). Own network
  `shopai`. Services: `postgres` (no ports), `server` (no ports), and one
  of `cloudflared` / `tailscale` / `caddy` for the web page per section 10.
- **Limits:** `server` 1 GB / 1.5 CPU (Playwright bursts), `postgres`
  256 MB with `shared_buffers=64MB`, `restart: unless-stopped`, json-file
  logs 10 MB x 5.
- **Healthchecks:** Postgres `pg_isready`; server liveness file touched by
  the polling loop, plus `GET /healthz` on loopback.
- **Deploy path:** private GitHub repo; on the server `git pull && docker
  compose up -d --build`; `make deploy` from your PC wraps it over SSH.
  Rollback is a tag checkout and rebuild. Migrations run on boot.
- **Out of scope:** OS or Docker daemon changes, firewall changes beyond
  what our own services need (which is nothing inbound).

---

## 15. Phases

| Phase | Scope | Value when done |
| --- | --- | --- |
| **0 - Recon** (half a day, needs SSH) | Server inventory; ZAGI tool-calling smoke test from the box; AH API recon (login exchange, search, detail, receipts, basket) with your account; BotFather bot; family Telegram ids | Go / no-go, `STORE-AH.md` written |
| **1 - Household + list** (about 1 week) | Monorepo scaffold, Postgres, core agent, `grocery` list / staples / facts, Telegram group + private, Docker on the server | Family uses the list daily |
| **2 - AH basket + learning** (1 to 2 weeks) | AH connector, purchase import, alias / brand model, matcher, fill pipeline with confirm gate, checkout link, bonus awareness | "Buy pasta" picks the right pasta and lands in the basket |
| **3 - Web page** (about 1 week) | SPA, magic-link auth, tunnel or Tailscale exposure, chat box on the web | Second interface live |
| **4 - Marketplace** (about 1 week) | bol.com and Amazon.nl connectors, `market.*` tools, compare, watchlist and price alerts | Non-grocery search and comparison |
| **5 - Planning** (about 1 week) | Meal plans, recipe book, weekly nudge, plan-to-list | The bot proposes, not only reacts |
| **6 - Later** | Trips capability, other shops, voice (needs STT), photos (needs vision on the gateway), `pgvector` search | Growth |

Phases 3 and 4 can swap depending on what the family wants first.

---

## 16. Open questions

1. **Server access.** SSH user and how you will hand over the key. Phase 0
   cannot start without it.
2. **Domain for the web page.** Do you have a domain, and is its DNS on
   Cloudflare? That decides tunnel vs Tailscale vs own Caddy.
3. **AH account.** Whose account will the bot use (one shared "Mijn AH"
   account is simplest), and is a Bonuskaart linked to it? That determines
   whether in-store receipts are available for learning.
4. **Marketplaces.** Confirm search, compare and links are enough for
   bol.com and Amazon.nl for now, with no basket filling there.
5. **Group listen mode.** Should the bot, in the family group, react to
   plain phrases like "we're out of eggs" without a mention? Default in
   this plan is off until an admin switches it on per group.
6. **Stack.** Confirm TypeScript + Postgres as argued in section 4.
