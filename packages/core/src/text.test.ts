import { test } from "node:test";
import assert from "node:assert/strict";
import { addressesBot, formatQty, normalizeName, truncate } from "./text.js";

const NICKS = ["shopai", "шопаи", "шоппер", "шон"];

test("addressesBot: nicknames as whole words, Latin and Cyrillic, any case", () => {
  assert.equal(addressesBot("шон, добавь молоко", "CheShopBot", NICKS), true);
  assert.equal(addressesBot("Шоппер купи хлеб", "CheShopBot", NICKS), true);
  assert.equal(addressesBot("hey ShopAI what's on the list?", "CheShopBot", NICKS), true);
  assert.equal(addressesBot("thanks @CheShopBot", "CheShopBot", NICKS), true);
  assert.equal(addressesBot("thanks @cheshopbot", "CheShopBot", NICKS), true);
});

test("addressesBot: does not fire inside other words or on unrelated text", () => {
  assert.equal(addressesBot("шоны были дорогие", "CheShopBot", NICKS), false); // шон + ы = other word
  assert.equal(addressesBot("workshop ai tools", "CheShopBot", NICKS), false);
  assert.equal(addressesBot("we're out of eggs", "CheShopBot", NICKS), false);
  assert.equal(addressesBot("", "CheShopBot", NICKS), false);
  assert.equal(addressesBot("шон", "CheShopBot", []), false);
});

test("addressesBot: nickname with regex metacharacters is escaped", () => {
  assert.equal(addressesBot("hi c++ bot", "b", ["c++"]), true);
});

test("normalizeName: lower-case, ё→е, punctuation stripped, spaces collapsed", () => {
  assert.equal(normalizeName("  Молоко,  2%  "), "молоко 2%");
  assert.equal(normalizeName("Ёгурт!"), "егурт");
  assert.equal(normalizeName("Grand'Italia Spaghetti"), "grand italia spaghetti");
});

test("formatQty", () => {
  assert.equal(formatQty(2, "l"), "2 l");
  assert.equal(formatQty("2.000", "l"), "2 l");
  assert.equal(formatQty(0.5, "kg"), "0.5 kg");
  assert.equal(formatQty(null, "pcs"), "pcs");
  assert.equal(formatQty(null, null), "");
  assert.equal(formatQty(3, null), "3");
});

test("truncate", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
});
