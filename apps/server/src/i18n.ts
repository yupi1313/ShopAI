export type Lang = "ru" | "en";

const STRINGS = {
  ru: {
    welcome: "Привет! Я ShopAI (Шон) — семейный помощник по покупкам. Пиши, что добавить в список, спрашивай, что купить. В группе позови меня по имени: шон, шопаи, шоппер.",
    help: "Команды:\n/list — показать список\n/done — всё куплено\n/staples — регулярные покупки\n/store ah — подключить Albert Heijn (в личке, админ)\n/reset — забыть контекст разговора\n/id — мой Telegram id\n\nПросто пиши: «шон, добавь молоко и бананы», «мы купили хлеб», «что у нас в списке?», «шон, сколько стоит молоко в АХ?»",
    notAuthorised: (id: number) => `Я семейный бот и отвечаю только своим. Твой Telegram id: ${id}. Попроси администратора добавить тебя.`,
    listTitle: "🛒 Список покупок",
    btnBought: "✅",
    btnRemove: "✖",
    btnRefresh: "🔄 Обновить",
    btnAllDone: "✅ Всё куплено",
    allDone: (n: number) => (n === 0 ? "Список и так пуст." : `Отметил как купленное: ${n}.`),
    markedBought: (name: string) => `Куплено: ${name}`,
    removed: (name: string) => `Убрал: ${name}`,
    resetDone: "Контекст разговора очищен.",
    modelDown: "Модель сейчас недоступна. Команды /list и кнопки работают.",
    busy: "Секунду, ещё думаю над предыдущим сообщением…",
    yourId: (uid: number, cid: number) => `Твой id: ${uid}\nЧат: ${cid}`,
    adminOnly: "Только для администратора.",
    staplesEmpty: "Регулярных покупок пока нет. Скажи мне, например: «кофе покупаем раз в 3 недели».",
    staplesTitle: "🔁 Регулярные покупки",
  },
  en: {
    welcome: "Hi! I'm ShopAI (Shon), the family shopping assistant. Tell me what to add to the list or ask what to buy. In the group, call me by name: shopai, шон.",
    help: "Commands:\n/list — show the list\n/done — everything bought\n/staples — regular items\n/store ah — connect Albert Heijn (private chat, admin)\n/reset — forget the conversation context\n/id — my Telegram id\n\nJust write: “shopai, add milk and bananas”, “we bought bread”, “what's on the list?”, “shopai, what does milk cost at AH?”",
    notAuthorised: (id: number) => `I am a family bot and only answer family members. Your Telegram id: ${id}. Ask the admin to add you.`,
    listTitle: "🛒 Shopping list",
    btnBought: "✅",
    btnRemove: "✖",
    btnRefresh: "🔄 Refresh",
    btnAllDone: "✅ All bought",
    allDone: (n: number) => (n === 0 ? "The list is already empty." : `Marked as bought: ${n}.`),
    markedBought: (name: string) => `Bought: ${name}`,
    removed: (name: string) => `Removed: ${name}`,
    resetDone: "Conversation context cleared.",
    modelDown: "The model is unavailable right now. /list and the buttons still work.",
    busy: "One moment, still working on the previous message…",
    yourId: (uid: number, cid: number) => `Your id: ${uid}\nChat: ${cid}`,
    adminOnly: "Admin only.",
    staplesEmpty: "No staples yet. Tell me, for example: “we buy coffee every 3 weeks”.",
    staplesTitle: "🔁 Staples",
  },
} as const;

export type Strings = (typeof STRINGS)["ru"];

export function pickLang(code: string | null | undefined): Lang {
  const c = (code ?? "").toLowerCase();
  if (c.startsWith("ru") || c.startsWith("uk") || c.startsWith("be")) return "ru";
  return "en";
}

export function t(lang: Lang): Strings {
  return STRINGS[lang] as Strings;
}
