/** Normalised product the rest of ShopAI sees; store-agnostic on purpose. */
export interface StoreProduct {
  store: "ah";
  id: string; // webshopId as string
  title: string;
  brand: string | null;
  size: string | null; // salesUnitSize, e.g. "1,5 l"
  price: number | null; // currentPrice (what you pay now)
  priceBeforeBonus: number | null;
  unitPrice: string | null; // e.g. "€1,26 per liter"
  isBonus: boolean;
  bonusUntil: string | null; // ISO date
  orderable: boolean;
  previouslyBought: boolean;
  category: string | null;
  imageUrl: string | null;
}

export interface ShoppingListItem {
  id: string;
  quantity: number;
  productId: number | null;
  description: string | null;
}

export interface ShoppingList {
  id: string;
  items: ShoppingListItem[];
}

/** One line of the member's basket (winkelwagen). */
export interface AhBasketItem {
  id: string;
  productId: number | null;
  quantity: number;
  /** list = normal basket line; order = already in an open order; external = non-AH item. */
  kind: "list" | "order" | "external";
}

export interface AhBasket {
  items: AhBasketItem[];
  /** Units in the basket as AH counts them. */
  quantity: number;
  totalPrice: number | null;
  /** AH's own formatting, e.g. "€ 12,34", when the API sends it. */
  totalFormatted: string | null;
}

/** One in-store receipt (kassabon) as listed. */
export interface AhReceiptSummary {
  id: string;
  /** ISO instant, e.g. 2026-09-16T18:31:00.000Z */
  dateTime: string;
  total: number | null;
}

export interface AhReceiptLine {
  /** Point-of-sale product id; maps to a webshop id via convertPosIds(). */
  posId: number | null;
  /** Abbreviated till name, e.g. "CAMP KWARK". */
  name: string;
  quantity: number;
  unitPrice: number | null;
  /** Line total as paid (before receipt-level discounts). */
  amount: number | null;
  weight: { amount: number; unit: string } | null;
}

export interface AhReceipt {
  id: string;
  storeId: number | null;
  /** Local till time as printed, e.g. "2026-09-16 20:31:00". */
  localDateTime: string | null;
  total: number | null;
  discountTotal: number | null;
  lines: AhReceiptLine[];
  discounts: Array<{ type: string | null; name: string; amount: number | null }>;
}

/** One online order as listed by orderFulfillments. */
export interface AhOrderSummary {
  orderId: number;
  closingDateTime: string | null;
  deliveryDate: string | null;
  total: number | null;
  status: string | null;
  shoppingType: string | null;
  completed: boolean;
}

export interface AhOrderLine {
  webshopId: number | null;
  title: string;
  brand: string | null;
  size: string | null;
  quantity: number;
  unitPrice: number | null;
  amount: number | null;
}

export interface AhOrder {
  orderId: number;
  state: string | null;
  closingTime: string | null;
  deliveryDate: string | null;
  lines: AhOrderLine[];
}

export class AhGraphqlError extends Error {
  constructor(
    readonly operation: string,
    readonly errors: Array<{ message: string; extensions?: Record<string, unknown> }>,
  ) {
    super(`AH graphql ${operation}: ${errors.map((e) => e.message).join("; ").slice(0, 300)}`);
    this.name = "AhGraphqlError";
  }
}

export interface AhTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
  /** false for the anonymous token, true after a member login. */
  member: boolean;
}

export class AhError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`AH ${path} -> HTTP ${status}: ${body.slice(0, 200)}`);
    this.name = "AhError";
  }
}

export class AhAuthExpiredError extends Error {
  constructor() {
    super("AH member session expired and could not be refreshed");
    this.name = "AhAuthExpiredError";
  }
}
