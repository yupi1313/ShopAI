import test from "node:test";
import assert from "node:assert/strict";
import { restrictToDepartment } from "./purchases.js";

const row = (qty: number, subcategory: string | null, category: string | null, title: string) => ({ qty: String(qty), subcategory, category, title });

test("melk: dairy wins, milk chocolate and wafers are dropped, unknown categories stay", () => {
  const rows = [
    row(79, "Houdbare melk", "Zuivel, eieren", "AH Houdbare halfvolle melk"),
    row(3, "Halfvolle melk", "Zuivel, eieren", "Campina halfvolle melk"),
    row(4, "Chocolademelk", "Zuivel, eieren", "Chocomel"),
    row(36, "Chocolade bites", "Koek, snoep, chocolade", "Franui Frambozen witte & melk chocolade"),
    row(16, "Wafels", "Koek, snoep, chocolade", "Knoppers Melk Hazelnootwafel"),
    row(3, "Melkchocolade", "Koek, snoep, chocolade", "Tony's melk"),
    row(2, null, null, "AH HV MELK"),
  ];
  const r = restrictToDepartment(rows, "melk");
  assert.equal(r.restrictedTo, "Zuivel, eieren");
  assert.equal(r.excluded, 3);
  assert.deepEqual(
    r.kept.map((x) => x.title),
    ["AH Houdbare halfvolle melk", "Campina halfvolle melk", "Chocomel", "AH HV MELK"],
  );
});

test("bier: wine shares the department but its sub-categories never say bier, so nothing is dropped wrongly", () => {
  const rows = [
    row(14, "Wit en weizen", "Bier, wijn, aperitieven", "Affligem Belgisch wit abdijbier 6-pack"),
    row(3, "Blond bier", "Bier, wijn, aperitieven", "Chouffe Soleil 4-pack"),
    row(5, "Pinot Grigio (Fris en droog)", "Bier, wijn, aperitieven", "Settesoli Pinot grigio"),
  ];
  // Only the beer rows got here (they matched on name or sub-category); the department is beer/wine.
  const r = restrictToDepartment(rows.slice(0, 2), "bier");
  assert.equal(r.restrictedTo, "Bier, wijn, aperitieven");
  assert.equal(r.excluded, 0);
});

test("brand queries match no sub-category and are left alone", () => {
  const rows = [row(2, "Wit en weizen", "Bier, wijn, aperitieven", "Affligem wit"), row(1, "Koekjes", "Koek, snoep, chocolade", "Affligem koek?")];
  const r = restrictToDepartment(rows, "affligem");
  assert.equal(r.restrictedTo, null);
  assert.equal(r.kept.length, 2);
});

test("no clear majority: nothing is dropped", () => {
  const rows = [row(5, "Melkchocolade", "Koek, snoep, chocolade", "Tony's melk"), row(5, "Houdbare melk", "Zuivel, eieren", "AH melk")];
  const r = restrictToDepartment(rows, "melk");
  assert.equal(r.restrictedTo, null);
  assert.equal(r.excluded, 0);
});
