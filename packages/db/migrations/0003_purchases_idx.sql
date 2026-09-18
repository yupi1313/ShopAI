-- Purchase history import (in-store receipts + online orders): query paths.
CREATE INDEX IF NOT EXISTS purchases_household_bought_idx ON purchases (household_id, bought_at DESC);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items (purchase_id);
CREATE INDEX IF NOT EXISTS purchase_items_product_idx ON purchase_items (product_id);
