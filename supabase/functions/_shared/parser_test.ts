// Deno tests for the pure query parser.
// Run: deno test supabase/functions/_shared/parser_test.ts

import { assertEquals } from "jsr:@std/assert@1";
import { type BuildingRef, parseQuery } from "./parser.ts";

const BUILDINGS: BuildingRef[] = [
  { code: "RT", name: "Raffles Tower" },
  { code: "AH", name: "Alexander House" },
  { code: "AC", name: "Arcades Cliderlex" },
  { code: "FSB", name: "Fon Sing Building" },
  { code: "JC", name: "Jade Court" },
  { code: "JH", name: "Jade House" },
  { code: "M", name: "Manhattan" },
  { code: "W", name: "Windsor" },
  { code: "PS", name: "Palm Square" },
];

function p(raw: string, override?: Parameters<typeof parseQuery>[2]) {
  return parseQuery(raw, BUILDINGS, override);
}

Deno.test("RT - 1D -> RT, keyword 1d, category all", () => {
  const r = p("RT - 1D");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.buildingName, "Raffles Tower");
  assertEquals(r.keyword, "1d");
  assertEquals(r.keywordTokens, ["1d"]);
  assertEquals(r.category, "all");
  assertEquals(r.picsMode, false);
});

Deno.test("RT 1D pdf plan -> pdf wins, plan becomes keyword", () => {
  const r = p("RT 1D pdf plan");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "pdf");
  assertEquals(r.keywordTokens, ["1d", "plan"]);
  assertEquals(r.keyword, "1d plan");
});

Deno.test("Pics RT 1D -> images + picsMode", () => {
  const r = p("Pics RT 1D");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "images");
  assertEquals(r.picsMode, true);
  assertEquals(r.keyword, "1d");
});

Deno.test("look for RT -1D pdf -> filler dropped, glued dash split", () => {
  const r = p("look for RT -1D pdf");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keyword, "1d");
  assertEquals(r.category, "pdf");
});

Deno.test("windsor 2A dwg -> W by name", () => {
  const r = p("windsor 2A dwg");
  assertEquals(r.buildingCode, "W");
  assertEquals(r.buildingName, "Windsor");
  assertEquals(r.keyword, "2a");
  assertEquals(r.category, "dwg");
});

Deno.test("1D RT pdf -> order independent", () => {
  const r = p("1D RT pdf");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keyword, "1d");
  assertEquals(r.category, "pdf");
});

Deno.test("M 3b photos -> Manhattan by single-letter code + picsMode", () => {
  const r = p("M 3b photos");
  assertEquals(r.buildingCode, "M");
  assertEquals(r.buildingName, "Manhattan");
  assertEquals(r.keyword, "3b");
  assertEquals(r.category, "images");
  assertEquals(r.picsMode, true);
});

Deno.test("no building -> find 1D pdf", () => {
  const r = p("find 1D pdf");
  assertEquals(r.buildingCode, null);
  assertEquals(r.buildingName, null);
  assertEquals(r.keyword, "1d");
  assertEquals(r.category, "pdf");
});

Deno.test("no keyword -> RT pdf", () => {
  const r = p("RT pdf");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keywordTokens, []);
  assertEquals(r.keyword, "");
  assertEquals(r.category, "pdf");
});

Deno.test("two-word building name -> raffles tower 1d", () => {
  const r = p("raffles tower 1d");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keyword, "1d");
  assertEquals(r.category, "all");
});

Deno.test("categoryOverride replaces parsed category", () => {
  // Typed 'pics' (images + picsMode) but override to pdf -> pdf, picsMode false.
  const r = p("Pics RT 1D", "pdf");
  assertEquals(r.category, "pdf");
  assertEquals(r.picsMode, false);
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keyword, "1d");
});

Deno.test("categoryOverride images without pics word -> no picsMode", () => {
  const r = p("RT 1D", "images");
  assertEquals(r.category, "images");
  assertEquals(r.picsMode, false);
});

Deno.test("multi-word FSB code + slash separators", () => {
  const r = p("FSB/2C/dwg");
  assertEquals(r.buildingCode, "FSB");
  assertEquals(r.keyword, "2c");
  assertEquals(r.category, "dwg");
});

Deno.test("everything keyword maps to category all, not filler", () => {
  const r = p("RT everything 5a");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "all");
  assertEquals(r.keyword, "5a");
});

Deno.test("RT pics -> images picsMode, empty keyword allowed", () => {
  const r = p("RT pics");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "images");
  assertEquals(r.picsMode, true);
  assertEquals(r.keywordTokens, []);
});

Deno.test("RT 2C word -> word, keyword 2c", () => {
  const r = p("RT 2C word");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "word");
  assertEquals(r.keyword, "2c");
  assertEquals(r.keywordTokens, ["2c"]);
  assertEquals(r.picsMode, false);
});

Deno.test("doc / docx / docs synonyms map to word", () => {
  assertEquals(p("RT 2C doc").category, "word");
  assertEquals(p("RT 2C docx").category, "word");
  assertEquals(p("RT 2C docs").category, "word");
});

Deno.test("JC 1a excel -> excel", () => {
  const r = p("JC 1a excel");
  assertEquals(r.buildingCode, "JC");
  assertEquals(r.category, "excel");
  assertEquals(r.keyword, "1a");
});

Deno.test("excel synonyms map to excel", () => {
  assertEquals(p("JC 1a xls").category, "excel");
  assertEquals(p("JC 1a xlsx").category, "excel");
  assertEquals(p("JC 1a sheet").category, "excel");
  assertEquals(p("JC 1a spreadsheet").category, "excel");
});

Deno.test("psd RT logo -> psd, keyword logo", () => {
  const r = p("psd RT logo");
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.category, "psd");
  assertEquals(r.keyword, "logo");
  assertEquals(r.keywordTokens, ["logo"]);
});

Deno.test("photoshop synonym maps to psd", () => {
  assertEquals(p("RT logo photoshop").category, "psd");
});

Deno.test("categoryOverride to a new category (excel)", () => {
  // Typed 'pics' (images + picsMode) but override to excel -> excel, no picsMode.
  const r = p("Pics RT 1D", "excel");
  assertEquals(r.category, "excel");
  assertEquals(r.picsMode, false);
  assertEquals(r.buildingCode, "RT");
  assertEquals(r.keyword, "1d");
});
