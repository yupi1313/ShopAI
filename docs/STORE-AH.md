# Albert Heijn connector notes

Recon done 2026-09-16 from the server (Nuremberg, DE IP). AH's mobile API
answers from the DE box, so the connector runs there fine. This is the
private `Appie` mobile API; treat it as unofficial and fail gracefully.

## Auth

- **Anonymous token** (enough for search and product detail):
  `POST https://api.ah.nl/mobile-auth/v1/auth/token/anonymous`
  body `{"clientId":"appie"}` →
  `{ access_token, refresh_token, expires_in }` (verified; `expires_in`
  about 604800 s = 7 days).
- **Member login** is an OAuth code flow. The human opens, in their own
  browser:
  `https://login.ah.nl/secure/oauth/authorize?client_id=appie&redirect_uri=appie://login-exit&response_type=code`
  logs in with their AH account + password, and is redirected to
  `appie://login-exit?code=<CODE>` (a URL the phone/desktop cannot open, so
  they copy it). The bot then exchanges it:
  `POST https://api.ah.nl/mobile-auth/v1/auth/token`
  body `{"clientId":"appie","code":"<CODE>"}` (path verified: a bogus code
  returns 400 "Incorrect request send by client", so the endpoint is live).
  **The bot never sees the password.**
- **Refresh:** `POST https://api.ah.nl/mobile-auth/v1/auth/token/refresh`
  body `{"clientId":"appie","refreshToken":"<RT>"}` (per community clients;
  verify on first real refresh).

Required headers on every call: `x-application: AHWEBSHOP`, an app-like
`user-agent` (e.g. `Appie/8.22.3 Model/phone Android/13`), and
`authorization: Bearer <token>`.

## Read endpoints (verified with the anonymous token)

- **Search:** `GET /mobile-services/product/search/v2?query=<q>&size=<n>&page=<p>`
  → `{ products: [...], page: { totalElements } }`. Verified: "melk" → 908
  results. Per-product fields we map:
  `webshopId` (numeric id), `title`, `brand`, `salesUnitSize` (e.g. "1,5 l"),
  `priceBeforeBonus`, `currentPrice`, `unitPriceDescription`, `isBonus`,
  `bonusStartDate`, `bonusEndDate`, `bonusMechanism`, `orderAvailabilityStatus`
  (`IN_ASSORTMENT` etc.), `isOrderable`, `availableOnline`, `images`,
  `mainCategory`, and crucially **`isPreviouslyBought`** — a per-member flag
  we can use for matching even before we import full order history.
- **Product detail:** `GET /mobile-services/product/detail/v4/fir/{webshopId}`
  → `{ productId, productCard, tradeItem, properties, disclaimerText }`
  (verified 200).

## Basket target: the AH shopping list

The online-order basket endpoints are not cleanly reachable; the robust,
AH-sanctioned path is the app's own shopping list ("Mijn lijst"):

- **Read:** `GET /mobile-services/shoppinglist/v2/items` → `{ id, items: [],
  storeNumber, ... }` (verified 200; with an anonymous token you get an
  anonymous list, with a member token the family's real list).
- **Write:** `PATCH /mobile-services/shoppinglist/v2/items` — verb verified
  (wrong body returns 400 "Failed to read request", not 404/405). The exact
  body was not nailed anonymously; **finalise it during the first member
  login** by reading the app's own request or trial with the member token.
  The connector isolates this in one method (`shoppingListAdd`) so only that
  method changes.

Flow: the bot fills the shopping list; the family opens the AH app where the
list is already there and turns it into a basket with one tap, then pays.
Same "bot fills, human pays" boundary; no payment data ever touches the bot.

## Purchase history (for brand learning)

- `/mobile-services/v1/receipts` and several guessed receipt paths returned
  404 with the anonymous token. Receipts are member-only and the path needs
  confirming **with a member token** during login. Fallback that already
  works today: `isPreviouslyBought` on search results plus our own
  `purchases` table filled from what the family marks bought and, later, the
  receipts endpoint once its path is confirmed.
- `POST /mobile-services/order/v1/orders` exists (GET → 405) but is for
  placing orders and is out of scope: the bot never checks out.

## Rate / etiquette

Cache search per query ~1 h and product detail ~1 day; one request at a
time per token; back off on 429. Probe AH gently: this is a private API and
heavy anonymous probing is what gets an IP throttled.

## Status

Connector `@shopai/connector-ah` implements: anonymous + member tokens,
refresh, search, product detail, shopping-list read/add. Search, detail and
list-read are verified live. Member login, the exact shopping-list write
body, and the receipts path are confirmed during the first `/store login`.
