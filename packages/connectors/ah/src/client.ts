import {
  AhAuthExpiredError,
  AhError,
  AhGraphqlError,
  type AhBasket,
  type AhOrder,
  type AhOrderSummary,
  type AhReceipt,
  type AhReceiptSummary,
  type AhTokens,
  type ShoppingList,
  type StoreProduct,
} from "./types.js";

const BASE = "https://api.ah.nl";
const AUTH_BASE = `${BASE}/mobile-auth/v1/auth`;
const SVC = `${BASE}/mobile-services`;
/**
 * AH's GraphQL API on the mobile host: the same schema the website talks to
 * at www.ah.nl/gql, but this host accepts the app bearer token and is not
 * fenced by Akamai for the server. Found 2026-09-17 (docs/STORE-AH.md).
 */
const GRAPHQL = `${BASE}/graphql`;

// A basket has three kinds of lines: itemsInList (the normal basket lines,
// id = product id), itemsInOrder (lines already in an open order) and
// externalItems. The family's real basket showed up entirely in itemsInList.
const BASKET_FIELDS =
  "itemsInList { id quantity __typename } externalItems { id quantity __typename } itemsInOrder { id quantity product { id __typename } __typename } summary { quantity price { totalPrice { amount formattedV2 __typename } __typename } __typename } __typename";
export const BASKET_QUERY = `query basket { basket { ${BASKET_FIELDS} } }`;
/** Captured from the website's quantity stepper on 2026-09-17; quantities are absolute per product. */
export const BASKET_MUTATION = `mutation basketItemsUpdate($items: [BasketMutation!]!) { basketItemsUpdate(items: $items) { result { ${BASKET_FIELDS} } __typename } }`;

// Purchase history. In-store receipts (kassabonnen) live behind
// posReceiptsPage / posReceiptDetails; their product ids are till ids that
// productConvertId maps to webshop ids. Online orders are listed by
// orderFulfillments and detailed by a REST endpoint. All verified with the
// family's member token on 2026-09-18 (docs/STORE-AH.md).
export const RECEIPTS_QUERY =
  "query FetchPosReceipts($offset: Int!, $limit: Int!) { posReceiptsPage(pagination: {offset: $offset, limit: $limit}) { pagination { offset limit totalElements } posReceipts { id dateTime totalAmount { amount } } } }";
export const RECEIPT_QUERY =
  "query FetchReceipt($id: String!) { posReceiptDetails(id: $id) { id storeInfo total { amount } discountTotal { amount } transaction { store dateTime } products { id quantity name price { amount } amount { amount } weight { amount unit } } discounts { type name amount { amount } } } }";
export const ORDERS_QUERY =
  "query OrderFulfillments($status: FulfillmentStatus!) { orderFulfillments(status: $status) { result { orderId statusCode statusDescription shoppingType transactionCompleted closingDateTime totalPrice { totalPrice { amount } } delivery { method slot { date } } } } }";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface RawBasketLine {
  id?: string | number;
  quantity?: number;
}

interface RawBasket {
  itemsInList?: RawBasketLine[] | null;
  externalItems?: RawBasketLine[] | null;
  itemsInOrder?: Array<RawBasketLine & { product?: { id?: number } | null }> | null;
  summary?: { quantity?: number; price?: { totalPrice?: { amount?: number; formattedV2?: string } | null } | null } | null;
}

function numericId(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/u.test(v)) return Number(v);
  return null;
}

function normalizeBasket(raw: RawBasket | null | undefined): AhBasket {
  const items: AhBasket["items"] = [];
  for (const i of raw?.itemsInList ?? []) items.push({ id: String(i.id ?? ""), productId: numericId(i.id), quantity: i.quantity ?? 0, kind: "list" });
  for (const i of raw?.itemsInOrder ?? []) {
    items.push({ id: String(i.id ?? ""), productId: numericId(i.product?.id) ?? numericId(i.id), quantity: i.quantity ?? 0, kind: "order" });
  }
  for (const i of raw?.externalItems ?? []) items.push({ id: String(i.id ?? ""), productId: numericId(i.id), quantity: i.quantity ?? 0, kind: "external" });
  const total = raw?.summary?.price?.totalPrice;
  return {
    items,
    quantity: raw?.summary?.quantity ?? items.reduce((a, i) => a + i.quantity, 0),
    totalPrice: total?.amount ?? null,
    totalFormatted: total?.formattedV2 ?? null,
  };
}
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

  /** One GraphQL operation against api.ah.nl/graphql. Throws AhGraphqlError when AH returns errors and no data. */
  async graphql<T>(
    operationName: string,
    query: string,
    variables: Record<string, unknown> = {},
    opts: { requireMember?: boolean; timeoutMs?: number } = {},
  ): Promise<T> {
    const t = await this.tokens.get();
    if (opts.requireMember && !t.member) throw new AhAuthExpiredError();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
    try {
      const res = await this.fetchImpl(GRAPHQL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          accept: "application/graphql-response+json,application/json;q=0.9",
          "user-agent": USER_AGENT,
          "x-application": "AHWEBSHOP",
          authorization: `Bearer ${t.accessToken}`,
          ...(opts.requireMember ? { "x-require-member": "true" } : {}),
        },
        body: JSON.stringify({ operationName, variables, query }),
      });
      const text = await res.text();
      if (!res.ok) throw new AhError(res.status, `/graphql ${operationName}`, text);
      const body = JSON.parse(text) as {
        data?: T | null;
        errors?: Array<{ message: string; extensions?: Record<string, unknown> }>;
      };
      if (body.data === null || body.data === undefined) {
        throw new AhGraphqlError(operationName, body.errors?.length ? body.errors : [{ message: "empty response" }]);
      }
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One page of in-store receipts, newest first. `total` in the result is the overall count. */
  async receipts(offset = 0, limit = 50): Promise<{ total: number; receipts: AhReceiptSummary[] }> {
    const data = await this.graphql<{
      posReceiptsPage: { pagination?: { totalElements?: number } | null; posReceipts?: Array<{ id: string; dateTime: string; totalAmount?: { amount?: number } | null }> | null } | null;
    }>("FetchPosReceipts", RECEIPTS_QUERY, { offset, limit: Math.min(100, Math.max(1, limit)) }, { requireMember: true });
    const page = data.posReceiptsPage;
    const receipts = (page?.posReceipts ?? []).map((r) => ({ id: r.id, dateTime: r.dateTime, total: num(r.totalAmount?.amount) }));
    return { total: page?.pagination?.totalElements ?? receipts.length, receipts };
  }

  async receipt(id: string): Promise<AhReceipt> {
    const data = await this.graphql<{
      posReceiptDetails: {
        id: string;
        storeInfo?: string[] | null;
        total?: { amount?: number } | null;
        discountTotal?: { amount?: number } | null;
        transaction?: { store?: number; dateTime?: string } | null;
        products?: Array<{
          id?: number | null;
          quantity?: number | null;
          name?: string | null;
          price?: { amount?: number } | null;
          amount?: { amount?: number } | null;
          weight?: { amount?: number; unit?: string } | null;
        }> | null;
        discounts?: Array<{ type?: string | null; name?: string | null; amount?: { amount?: number } | null }> | null;
      } | null;
    }>("FetchReceipt", RECEIPT_QUERY, { id }, { requireMember: true });
    const r = data.posReceiptDetails;
    if (!r) throw new AhGraphqlError("FetchReceipt", [{ message: "receipt not found" }]);
    return {
      id: r.id,
      storeId: num(r.transaction?.store) ?? (r.storeInfo?.[0] ? Number(r.storeInfo[0]) || null : null),
      localDateTime: r.transaction?.dateTime ?? null,
      total: num(r.total?.amount),
      discountTotal: num(r.discountTotal?.amount),
      lines: (r.products ?? []).map((p) => ({
        posId: num(p.id),
        name: (p.name ?? "").trim(),
        quantity: num(p.quantity) ?? 1,
        unitPrice: num(p.price?.amount),
        amount: num(p.amount?.amount),
        weight: p.weight && num(p.weight.amount) !== null ? { amount: p.weight.amount as number, unit: p.weight.unit ?? "" } : null,
      })),
      discounts: (r.discounts ?? []).map((d) => ({ type: d.type ?? null, name: (d.name ?? "").trim(), amount: num(d.amount?.amount) })),
    };
  }

  /**
   * Map till product ids (PosReceiptProduct.id) to webshop ids. One aliased
   * query per 50 ids; unknown ids are left out of the result.
   */
  async convertPosIds(ids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const unique = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))];
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const query = `query Convert { ${chunk.map((id, k) => `p${k}: productConvertId(sourceId: ${id})`).join(" ")} }`;
      const data = await this.graphql<Record<string, number | null>>("Convert", query);
      chunk.forEach((id, k) => {
        const v = data[`p${k}`];
        if (typeof v === "number" && v > 0) out.set(id, v);
      });
    }
    return out;
  }

  /** Every online order (open and closed), newest first. */
  async orders(): Promise<AhOrderSummary[]> {
    const data = await this.graphql<{
      orderFulfillments: {
        result?: Array<{
          orderId: number;
          statusCode?: number;
          statusDescription?: string | null;
          shoppingType?: string | null;
          transactionCompleted?: boolean;
          closingDateTime?: string | null;
          totalPrice?: { totalPrice?: { amount?: number } | null } | null;
          delivery?: { method?: string | null; slot?: { date?: string | null } | null } | null;
        }> | null;
      } | null;
    }>("OrderFulfillments", ORDERS_QUERY, { status: "ALL" }, { requireMember: true });
    return (data.orderFulfillments?.result ?? []).map((o) => ({
      orderId: o.orderId,
      closingDateTime: o.closingDateTime ?? null,
      deliveryDate: o.delivery?.slot?.date ?? null,
      total: num(o.totalPrice?.totalPrice?.amount),
      status: o.statusDescription ?? null,
      shoppingType: o.shoppingType ?? null,
      completed: Boolean(o.transactionCompleted),
    }));
  }

  /** Lines of one online order (REST, grouped by taxonomy on AH's side, flattened here). */
  async order(orderId: number): Promise<AhOrder> {
    const res = await this.authGet(`/order/v1/${orderId}/details-grouped-by-taxonomy`);
    const text = await res.text();
    if (!res.ok) throw new AhError(res.status, `/order/v1/${orderId}/details-grouped-by-taxonomy`, text);
    const body = JSON.parse(text) as {
      orderId?: number;
      orderState?: string;
      closingTime?: string;
      deliveryDate?: string;
      groupedProductsInTaxonomy?: Array<{
        orderedProducts?: Array<{
          amount?: number;
          quantity?: number;
          allocatedQuantity?: number;
          price?: number;
          totalPrice?: number;
          product?: { webshopId?: number; title?: string; brand?: string; salesUnitSize?: string; currentPrice?: number; priceBeforeBonus?: number };
        }>;
      }>;
    };
    const lines = (body.groupedProductsInTaxonomy ?? []).flatMap((g) =>
      (g.orderedProducts ?? []).map((op) => {
        const quantity = num(op.allocatedQuantity) ?? num(op.quantity) ?? num(op.amount) ?? 1;
        const unitPrice = num(op.price) ?? num(op.product?.currentPrice) ?? num(op.product?.priceBeforeBonus);
        return {
          webshopId: num(op.product?.webshopId),
          title: op.product?.title ?? "",
          brand: op.product?.brand ?? null,
          size: op.product?.salesUnitSize ?? null,
          quantity,
          unitPrice,
          amount: num(op.totalPrice) ?? (unitPrice === null ? null : Math.round(unitPrice * quantity * 100) / 100),
        };
      }),
    );
    return { orderId: body.orderId ?? orderId, state: body.orderState ?? null, closingTime: body.closingTime ?? null, deliveryDate: body.deliveryDate ?? null, lines };
  }

  /** The member's online-order basket. */
  async basket(): Promise<AhBasket> {
    const data = await this.graphql<{ basket: RawBasket | null }>("basket", BASKET_QUERY, {}, { requireMember: true });
    return normalizeBasket(data.basket);
  }

  /**
   * Set basket quantities (absolute per product, like the website's stepper).
   * Returns the basket as AH reports it after the change.
   */
  async basketItemsUpdate(items: Array<{ productId: number; quantity: number }>): Promise<AhBasket> {
    if (items.length === 0) throw new Error("basketItemsUpdate: no items");
    const data = await this.graphql<{ basketItemsUpdate: { result: RawBasket | null } | null }>(
      "basketItemsUpdate",
      BASKET_MUTATION,
      { items: items.map((i) => ({ id: i.productId, quantity: i.quantity, description: null })) },
      { requireMember: true },
    );
    return normalizeBasket(data.basketItemsUpdate?.result);
  }
}
