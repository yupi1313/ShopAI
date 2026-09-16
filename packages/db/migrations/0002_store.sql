-- Phase 2: Albert Heijn store integration, product cache, aliases, purchase history.

CREATE TABLE store_accounts (
  id             serial PRIMARY KEY,
  household_id   integer NOT NULL REFERENCES households(id),
  store          text NOT NULL DEFAULT 'ah',
  label          text,
  enc_tokens     text,                    -- AES-256-GCM blob: JSON { accessToken, refreshToken, expiresAt, member }
  status         text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected', 'connected', 'expired')),
  connected_at   timestamptz,
  last_error     text,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX store_accounts_household_store_uq ON store_accounts (household_id, store);

CREATE TABLE products (
  store            text NOT NULL,
  product_id       text NOT NULL,
  title            text NOT NULL,
  brand            text,
  size             text,
  price            numeric(12,2),
  price_before_bonus numeric(12,2),
  unit_price       text,
  is_bonus         boolean NOT NULL DEFAULT false,
  bonus_until      date,
  category         text,
  image_url        text,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store, product_id)
);

CREATE TABLE product_aliases (
  id             serial PRIMARY KEY,
  household_id   integer NOT NULL REFERENCES households(id),
  name_norm      text NOT NULL,
  store          text NOT NULL DEFAULT 'ah',
  product_id     text NOT NULL,
  source         text NOT NULL DEFAULT 'llm' CHECK (source IN ('human', 'order', 'llm')),
  locked         boolean NOT NULL DEFAULT false,
  score          integer NOT NULL DEFAULT 1,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_aliases_uq ON product_aliases (household_id, store, name_norm);

CREATE TABLE purchases (
  id             bigserial PRIMARY KEY,
  household_id   integer NOT NULL REFERENCES households(id),
  store          text NOT NULL DEFAULT 'ah',
  external_id    text,                    -- receipt / order id, for idempotent import
  bought_at      timestamptz NOT NULL,
  channel        text,                    -- 'online' | 'store'
  total          numeric(12,2),
  imported_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchases_external_uq ON purchases (household_id, store, external_id);

CREATE TABLE purchase_items (
  id             bigserial PRIMARY KEY,
  purchase_id    bigint NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  name_raw       text NOT NULL,
  name_norm      text NOT NULL,
  product_id     text,
  brand          text,
  qty            numeric(12,3),
  unit           text,
  price          numeric(12,2)
);
CREATE INDEX purchase_items_norm_idx ON purchase_items (name_norm);
