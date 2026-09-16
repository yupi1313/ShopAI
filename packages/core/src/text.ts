/** Normalise a product/item name for matching: lower-case, trimmed, single spaces, no punctuation, ё→е. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N}\s%+-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Escape text for Telegram HTML parse mode. */
export function escapeHtml(s: string): string {
  return s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
}

/** Format a quantity + unit compactly: 2 l, 500 g, 3 pcs, or empty. */
export function formatQty(qty: number | string | null | undefined, unit: string | null | undefined): string {
  if (qty === null || qty === undefined || qty === "") return unit ? unit : "";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (!Number.isFinite(n)) return unit ?? "";
  const num = Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  return unit ? `${num} ${unit}` : num;
}

/**
 * Does `text` address the bot? Matches @username, or any nickname as a whole
 * word (Latin or Cyrillic), case-insensitively. Nicknames are escaped for regex.
 */
export function addressesBot(text: string, botUsername: string, nicknames: string[]): boolean {
  if (!text) return false;
  if (botUsername && new RegExp(`@${escapeRegex(botUsername)}\\b`, "iu").test(text)) return true;
  const names = nicknames.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return false;
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${names.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`, "iu");
  return re.test(text);
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`;
}
