-- AH's fine category ("Zwaar bier", "Witte wijn"); the coarse one ("Bier, wijn, aperitieven") is too broad for history queries.
ALTER TABLE products ADD COLUMN IF NOT EXISTS subcategory text;
