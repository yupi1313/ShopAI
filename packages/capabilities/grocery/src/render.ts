import type { ListItem, Staple } from "@shopai/db";
import { escapeHtml, formatQty } from "@shopai/core";

/** Compact list snapshot for the system prompt. */
export function listForPrompt(items: ListItem[], max = 40): string {
  if (items.length === 0) return "Shopping list: empty.";
  const lines = items.slice(0, max).map((i) => {
    const q = formatQty(i.qty, i.unit);
    const flag = i.status === "in_basket" ? " [in basket]" : "";
    const note = i.note ? ` (${i.note})` : "";
    return `- #${i.id} ${i.nameRaw}${q ? ` ${q}` : ""}${note}${flag}`;
  });
  const more = items.length > max ? `\n… and ${items.length - max} more` : "";
  return `Shopping list (${items.length} open items, ids in #):\n${lines.join("\n")}${more}`;
}

export function staplesForPrompt(rows: Staple[]): string {
  if (rows.length === 0) return "";
  const lines = rows.slice(0, 30).map((s) => {
    const cad = s.cadenceDays ? ` every ~${s.cadenceDays} days` : "";
    const last = s.lastBoughtAt ? ` last bought ${s.lastBoughtAt.toISOString().slice(0, 10)}` : "";
    return `- ${s.nameDisplay}${cad}${last}`;
  });
  return `Staples (things the family buys regularly):\n${lines.join("\n")}`;
}

/** Telegram HTML rendering of the list. */
export function listAsHtml(items: ListItem[], title = "🛒 Shopping list"): string {
  if (items.length === 0) return `<b>${escapeHtml(title)}</b>\n\nEmpty. Tell me what to add.`;
  const lines = items.map((i, idx) => {
    const q = formatQty(i.qty, i.unit);
    const note = i.note ? ` <i>(${escapeHtml(i.note)})</i>` : "";
    const flag = i.status === "in_basket" ? " 🧺" : "";
    return `${idx + 1}. ${escapeHtml(i.nameRaw)}${q ? ` — ${escapeHtml(q)}` : ""}${note}${flag}`;
  });
  return `<b>${escapeHtml(title)}</b> (${items.length})\n\n${lines.join("\n")}`;
}
