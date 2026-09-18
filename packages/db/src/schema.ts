// Drizzle schema. The authoritative DDL is the SQL in ../migrations; this file
// mirrors it so queries are typed. Keep the two in sync when adding columns.

import {
  bigint,
  bigserial,
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const households = pgTable("households", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  locale: text("locale").notNull().default("nl-NL"),
  timezone: text("timezone").notNull().default("Europe/Amsterdam"),
  currency: text("currency").notNull().default("EUR"),
  settings: jsonb("settings").$type<HouseholdSettings>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export interface HouseholdSettings {
  /** Nicknames that address the bot in group chats, matched as whole words. */
  nicknames?: string[];
}

export const members = pgTable("members", {
  id: serial("id").primaryKey(),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull().unique(),
  displayName: text("display_name").notNull(),
  role: text("role").$type<"admin" | "member">().notNull().default("member"),
  language: text("language"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chats = pgTable("chats", {
  id: serial("id").primaryKey(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull().unique(),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  kind: text("kind").$type<"private" | "group" | "supergroup">().notNull(),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const lists = pgTable("lists", {
  id: serial("id").primaryKey(),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  name: text("name").notNull().default("Groceries"),
  status: text("status").$type<"active" | "archived">().notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ListItemStatus = "pending" | "in_basket" | "bought" | "removed";

export const listItems = pgTable("list_items", {
  id: serial("id").primaryKey(),
  listId: integer("list_id")
    .notNull()
    .references(() => lists.id),
  nameRaw: text("name_raw").notNull(),
  nameNorm: text("name_norm").notNull(),
  qty: numeric("qty", { precision: 12, scale: 3 }),
  unit: text("unit"),
  note: text("note"),
  status: text("status").$type<ListItemStatus>().notNull().default("pending"),
  addedBy: integer("added_by").references(() => members.id),
  productRef: jsonb("product_ref").$type<Record<string, unknown> | null>(),
  pickReason: text("pick_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const staples = pgTable(
  "staples",
  {
    id: serial("id").primaryKey(),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    nameNorm: text("name_norm").notNull(),
    nameDisplay: text("name_display").notNull(),
    cadenceDays: integer("cadence_days"),
    lastBoughtAt: timestamp("last_bought_at", { withTimezone: true }),
    preferredProduct: jsonb("preferred_product").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("staples_household_name_uq").on(t.householdId, t.nameNorm)],
);

export const householdFacts = pgTable(
  "household_facts",
  {
    id: serial("id").primaryKey(),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: text("source").$type<"member" | "inferred">().notNull().default("member"),
    setBy: integer("set_by").references(() => members.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("household_facts_key_uq").on(t.householdId, t.key)],
);

export interface StoredTurn {
  role: "user" | "assistant";
  /** Member display name for user turns, so the model knows who said what in a group. */
  who?: string;
  content: string;
  at: string;
}

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  chatKey: text("chat_key").notNull().unique(),
  householdId: integer("household_id")
    .notNull()
    .references(() => households.id),
  turns: jsonb("turns").$type<StoredTurn[]>().notNull().default([]),
  summary: text("summary"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const llmCalls = pgTable("llm_calls", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  chatKey: text("chat_key"),
  memberId: integer("member_id"),
  capability: text("capability"),
  model: text("model").notNull(),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  cachedTokens: integer("cached_tokens"),
  finishReason: text("finish_reason"),
  latencyMs: integer("latency_ms"),
  toolNames: text("tool_names").array(),
  error: text("error"),
});

export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  actorMemberId: integer("actor_member_id"),
  action: text("action").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
});

export const pendingActions = pgTable("pending_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  chatKey: text("chat_key").notNull(),
  memberId: integer("member_id"),
  tool: text("tool").notNull(),
  args: jsonb("args").$type<Record<string, unknown>>().notNull(),
  status: text("status").$type<"pending" | "confirmed" | "cancelled" | "expired">().notNull().default("pending"),
});

export const storeAccounts = pgTable(
  "store_accounts",
  {
    id: serial("id").primaryKey(),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    store: text("store").notNull().default("ah"),
    label: text("label"),
    encTokens: text("enc_tokens"),
    status: text("status").$type<"disconnected" | "connected" | "expired">().notNull().default("disconnected"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastError: text("last_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("store_accounts_household_store_uq").on(t.householdId, t.store)],
);

export const products = pgTable(
  "products",
  {
    store: text("store").notNull(),
    productId: text("product_id").notNull(),
    title: text("title").notNull(),
    brand: text("brand"),
    size: text("size"),
    price: numeric("price", { precision: 12, scale: 2 }),
    priceBeforeBonus: numeric("price_before_bonus", { precision: 12, scale: 2 }),
    unitPrice: text("unit_price"),
    isBonus: boolean("is_bonus").notNull().default(false),
    bonusUntil: text("bonus_until"),
    category: text("category"),
    subcategory: text("subcategory"),
    imageUrl: text("image_url"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.store, t.productId] })],
);

export const productAliases = pgTable(
  "product_aliases",
  {
    id: serial("id").primaryKey(),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    nameNorm: text("name_norm").notNull(),
    store: text("store").notNull().default("ah"),
    productId: text("product_id").notNull(),
    source: text("source").$type<"human" | "order" | "llm">().notNull().default("llm"),
    locked: boolean("locked").notNull().default(false),
    score: integer("score").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("product_aliases_uq").on(t.householdId, t.store, t.nameNorm)],
);

export const purchases = pgTable(
  "purchases",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    householdId: integer("household_id")
      .notNull()
      .references(() => households.id),
    store: text("store").notNull().default("ah"),
    externalId: text("external_id"),
    boughtAt: timestamp("bought_at", { withTimezone: true }).notNull(),
    channel: text("channel"),
    total: numeric("total", { precision: 12, scale: 2 }),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("purchases_external_uq").on(t.householdId, t.store, t.externalId)],
);

export const purchaseItems = pgTable("purchase_items", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  purchaseId: bigint("purchase_id", { mode: "number" })
    .notNull()
    .references(() => purchases.id, { onDelete: "cascade" }),
  nameRaw: text("name_raw").notNull(),
  nameNorm: text("name_norm").notNull(),
  productId: text("product_id"),
  brand: text("brand"),
  qty: numeric("qty", { precision: 12, scale: 3 }),
  unit: text("unit"),
  price: numeric("price", { precision: 12, scale: 2 }),
});

export type StoreAccount = typeof storeAccounts.$inferSelect;
export type ProductRow = typeof products.$inferSelect;
export type ProductAlias = typeof productAliases.$inferSelect;

export type Household = typeof households.$inferSelect;
export type Member = typeof members.$inferSelect;
export type Chat = typeof chats.$inferSelect;
export type List = typeof lists.$inferSelect;
export type ListItem = typeof listItems.$inferSelect;
export type Staple = typeof staples.$inferSelect;
export type HouseholdFact = typeof householdFacts.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
