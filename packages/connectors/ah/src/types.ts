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
