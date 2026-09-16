import { InlineKeyboard } from "grammy";
import type { ListItem } from "@shopai/db";
import { formatQty, truncate } from "@shopai/core";
import type { Strings } from "../i18n.js";

export const MAX_ITEM_BUTTONS = 30;

/** One row per open item: [✅ name qty] [✖]; plus refresh / all-done. */
export function listKeyboard(items: ListItem[], s: Strings): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const item of items.slice(0, MAX_ITEM_BUTTONS)) {
    const q = formatQty(item.qty, item.unit);
    const label = truncate(`${s.btnBought} ${item.nameRaw}${q ? ` ${q}` : ""}`, 32);
    kb.text(label, `li:b:${item.id}`).text(s.btnRemove, `li:r:${item.id}`).row();
  }
  kb.text(s.btnRefresh, "list:refresh");
  if (items.length > 0) kb.text(s.btnAllDone, "list:done");
  return kb;
}
