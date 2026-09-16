import {
  AhAuthExpiredError,
  AhError,
  type AhTokens,
  type ShoppingList,
  type StoreProduct,
} from "./types.js";

const BASE = "https://api.ah.nl";
const AUTH_BASE = `${BASE}/mobile-auth/v1/auth`;
const SVC = `${BASE}/mobile-services`;
const USER_AGENT = "Appie/8.22.3 Model/phone Android/13";
const CLIENT_ID = "appie";
export const AH_AUTHORIZE_URL = `https://login.ah.nl/secure/oauth/authorize?client_id=${CLIENT_ID}&redirect_uri=appie%3A%2F%2Flogin-exit&response_type=code`;

/** Web product page; opening it lets a family member add the item in the AH app/site. */
export function productDeepLink(webshopId: string | number): string {
  return `https://www.ah.nl/producten/product/wi${webshopId}`;
}

type FetchImpl = typeof fetch;

interface RawToken {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

function toTokens(raw: RawToken, member: boolean): AhTokens {
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token,
    // Refresh a minute early to avoid races.
    expiresAt: Date.now() + Math.max(0, raw.expires_in - 60) * 1000,
    member,
  };
}

async function postJson(fetchImpl: FetchImpl, path: string, body: unknown, timeoutMs = 20_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(path, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "user-agent": USER_AGENT, "x-application": "AHWEBSHOP" },
      body: JSON.stringify(body),
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Get a fresh anonymous token (search + product detail only). */
export async function anonymousToken(fetchImpl: FetchImpl = fetch): Promise<AhTokens> {
  const res = await postJson(fetchImpl, `${AUTH_BASE}/token/anonymous`, { clientId: CLIENT_ID });
  const text = await res.text();
  if (!res.ok) throw new AhError(res.status, "/auth/token/anonymous", text);
  return toTokens(JSON.parse(text) as RawToken, false);
}

/** Exchange the OAuth `code` (from appie://login-exit?code=...) for member tokens. */
export async function exchangeCode(code: string, fetchImpl: FetchImpl = fetch): Promise<AhTokens> {
  const res = await postJson(fetchImpl, `${AUTH_BASE}/token`, { clientId: CLIENT_ID, code });
  const text = await res.text();
  if (!res.ok) throw new AhError(res.status, "/auth/token", text);
  return toTokens(JSON.parse(text) as RawToken, true);
}

export async function refreshTokens(refreshToken: string, fetchImpl: FetchImpl = fetch): Promise<AhTokens> {
  const res = await postJson(fetchImpl, `${AUTH_BASE}/token/refresh`, { clientId: CLIENT_ID, refreshToken });
  const text = await res.text();
  if (!res.ok) throw new AhError(res.status, "/auth/token/refresh", text);
  return toTokens(JSON.parse(text) as RawToken, true);
}

/** Parse a pasted redirect URL or a bare code into the code string. */
export function extractCode(pasted: string): string | null {
  const s = pasted.trim();
  const m = s.match(/[?&]code=([^&\s]+)/u);
  if (m?.[1]) return decodeURIComponent(m[1]);
  // A bare code: no spaces, not a URL.
  if (s && !/\s/u.test(s) && !s.includes("://")) return s;
  return null;
}

interface RawProduct {
  webshopId?: number;
  title?: string;
  brand?: string;
  salesUnitSize?: string;
  currentPrice?: number;
  priceBeforeBonus?: number;
  unitPriceDescription?: string;
  isBonus?: boolean;
  bonusEndDate?: string;
  isOrderable?: boolean;
  isPreviouslyBought?: boolean;
  mainCategory?: string;
  images?: Array<{ url?: string; width?: number }>;
}

function normalizeProduct(p: RawProduct): StoreProduct {
  const img = (p.images ?? []).slice().sort((a, b) => (a.width ?? 0) - (b.width ?? 0)).find((i) => (i.width ?? 0) >= 200);
  return {
    store: "ah",
    id: String(p.webshopId ?? ""),
    title: p.title ?? "",
    brand: p.brand ?? null,
    size: p.salesUnitSize ?? null,
    // AH puts the payable price in currentPrice, but for non-bonus items only
    // priceBeforeBonus is set — fall back so search always shows a price.
    price: p.currentPrice ?? p.priceBeforeBonus ?? null,
    priceBeforeBonus: p.priceBeforeBonus ?? null,
    unitPrice: p.unitPriceDescription ?? null,
    isBonus: Boolean(p.isBonus),
    bonusUntil: p.bonusEndDate ?? null,
    orderable: p.isOrderable ?? true,
    previouslyBought: Boolean(p.isPreviouslyBought),
    category: p.mainCategory ?? null,
    imageUrl: img?.url ?? (p.images ?? [])[0]?.url ?? null,
  };
}

/** A token provider that keeps a valid access token, refreshing as needed. */
export interface TokenSource {
  get(): Promise<AhTokens>;
  onRefreshed?(tokens: AhTokens): Promise<void>;
}

export class AhClient {
  constructor(
    private readonly tokens: TokenSource,
    private readonly fetchImpl: FetchImpl = fetch,
  ) {}

  private async authGet(path: string, timeoutMs = 20_000): Promise<Response> {
    const t = await this.tokens.get();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(`${SVC}${path}`, {
        signal: controller.signal,
        headers: {
          "user-agent": USER_AGENT,
          "x-application": "AHWEBSHOP",
          authorization: `Bearer ${t.accessToken}`,
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, opts: { size?: number; page?: number } = {}): Promise<StoreProduct[]> {
    const size = Math.min(opts.size ?? 10, 50);
    const page = opts.page ?? 0;
    const res = await this.authGet(`/product/search/v2?query=${encodeURIComponent(query)}&size=${size}&page=${page}`);
    const text = await res.text();
    if (!res.ok) throw new AhError(res.status, "/product/search/v2", text);
    const body = JSON.parse(text) as { products?: RawProduct[] };
    return (body.products ?? []).map(normalizeProduct);
  }

  async product(webshopId: string | number): Promise<StoreProduct | null> {
    const res = await this.authGet(`/product/detail/v4/fir/${webshopId}`);
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) throw new AhError(res.status, "/product/detail/v4", text);
    const body = JSON.parse(text) as { productCard?: RawProduct; productId?: number };
    if (!body.productCard) return null;
    return normalizeProduct({ ...body.productCard, webshopId: body.productId });
  }

  async shoppingList(): Promise<ShoppingList> {
    const res = await this.authGet("/shoppinglist/v2/items");
    const text = await res.text();
    if (!res.ok) throw new AhError(res.status, "/shoppinglist/v2/items", text);
    // Real item shape: { listItemId, quantity, type, productDetails: { product: { webshopId, title } }, description? }
    const body = JSON.parse(text) as {
      id?: string;
      items?: Array<{
        listItemId?: number;
        quantity?: number;
        description?: string;
        productDetails?: { product?: { webshopId?: number; title?: string } };
      }>;
    };
    return {
      id: body.id ?? "",
      items: (body.items ?? []).map((i) => {
        const prod = i.productDetails?.product;
        return {
          id: String(i.listItemId ?? ""),
          quantity: i.quantity ?? 1,
          productId: prod?.webshopId ?? null,
          description: prod?.title ?? i.description ?? null,
        };
      }),
    };
  }

  /**
   * Add a product to the member's AH shopping list. The exact PATCH body is
   * confirmed with a member token during the first login; this uses the most
   * likely shape and throws AhError with the server message if AH rejects it,
   * so the login flow can report and we can adjust this one method.
   */
  async shoppingListAdd(productId: number, quantity = 1): Promise<void> {
    const t = await this.tokens.get();
    if (!t.member) throw new AhAuthExpiredError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const res = await this.fetchImpl(`${SVC}/shoppinglist/v2/items`, {
        method: "PATCH",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": USER_AGENT,
          "x-application": "AHWEBSHOP",
          authorization: `Bearer ${t.accessToken}`,
        },
        body: JSON.stringify({ items: [{ type: "PRODUCT", productId, quantity }] }),
      });
      const text = await res.text();
      if (!res.ok) throw new AhError(res.status, "/shoppinglist/v2/items PATCH", text);
    } finally {
      clearTimeout(timer);
    }
  }
}
