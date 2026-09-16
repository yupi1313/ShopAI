-- ShopAI initial schema. Mirrors packages/db/src/schema.ts.

CREATE TABLE households (
  id          serial PRIMARY KEY,
  name        text NOT NULL,
  locale      text NOT NULL DEFAULT 'nl-NL',
  timezone    text NOT NULL DEFAULT 'Europe/Amsterdam',
  currency    text NOT NULL DEFAULT 'EUR',
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE members (
  id                serial PRIMARY KEY,
  household_id      integer NOT NULL REFERENCES households(id),
  telegram_user_id  bigint NOT NULL UNIQUE,
  display_name      text NOT NULL,
  role              text NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  language          text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chats (
  id                serial PRIMARY KEY,
  telegram_chat_id  bigint NOT NULL UNIQUE,
  household_id      integer NOT NULL REFERENCES households(id),
  kind              text NOT NULL CHECK (kind IN ('private', 'group', 'supergroup')),
  title             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lists (
  id            serial PRIMARY KEY,
  household_id  integer NOT NULL REFERENCES households(id),
  name          text NOT NULL DEFAULT 'Groceries',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lists_household_status_idx ON lists (household_id, status);

CREATE TABLE list_items (
  id           serial PRIMARY KEY,
  list_id      integer NOT NULL REFERENCES lists(id),
  name_raw     text NOT NULL,
  name_norm    text NOT NULL,
  qty          numeric(12,3),
  unit         text,
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_basket', 'bought', 'removed')),
  added_by     integer REFERENCES members(id),
  product_ref  jsonb,
  pick_reason  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX list_items_list_status_idx ON list_items (list_id, status);

CREATE TABLE staples (
  id                 serial PRIMARY KEY,
  household_id       integer NOT NULL REFERENCES households(id),
  name_norm          text NOT NULL,
  name_display       text NOT NULL,
  cadence_days       integer,
  last_bought_at     timestamptz,
  preferred_product  jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX staples_household_name_uq ON staples (household_id, name_norm);

CREATE TABLE household_facts (
  id            serial PRIMARY KEY,
  household_id  integer NOT NULL REFERENCES households(id),
  key           text NOT NULL,
  value         text NOT NULL,
  source        text NOT NULL DEFAULT 'member' CHECK (source IN ('member', 'inferred')),
  set_by        integer REFERENCES members(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX household_facts_key_uq ON household_facts (household_id, key);

CREATE TABLE conversations (
  id            serial PRIMARY KEY,
  chat_key      text NOT NULL UNIQUE,
  household_id  integer NOT NULL REFERENCES households(id),
  turns         jsonb NOT NULL DEFAULT '[]'::jsonb,
  summary       text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE llm_calls (
  id                 bigserial PRIMARY KEY,
  created_at         timestamptz NOT NULL DEFAULT now(),
  chat_key           text,
  member_id          integer,
  capability         text,
  model              text NOT NULL,
  prompt_tokens      integer,
  completion_tokens  integer,
  reasoning_tokens   integer,
  cached_tokens      integer,
  finish_reason      text,
  latency_ms         integer,
  tool_names         text[],
  error              text
);
CREATE INDEX llm_calls_created_idx ON llm_calls (created_at);

CREATE TABLE audit_log (
  id               bigserial PRIMARY KEY,
  created_at       timestamptz NOT NULL DEFAULT now(),
  actor_member_id  integer,
  action           text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE pending_actions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  chat_key    text NOT NULL,
  member_id   integer,
  tool        text NOT NULL,
  args        jsonb NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired'))
);
CREATE INDEX pending_actions_chat_idx ON pending_actions (chat_key, status);
