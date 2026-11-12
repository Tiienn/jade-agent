import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  buildInvoiceStyleExamples,
  hasMeaningfulStyleEdit,
} from "./invoiceStyle.ts";

Deno.test("detects a real edit but ignores surrounding whitespace", () => {
  assert(hasMeaningfulStyleEdit("Hello\nRegards", "Hello there\nRegards"));
  assertEquals(hasMeaningfulStyleEdit("  Hello\r\nRegards  ", "Hello\nRegards"), false);
});

Deno.test("returns no prompt block without examples", () => {
  assertEquals(buildInvoiceStyleExamples([]), "");
});

Deno.test("labels the user's edit and forbids copying invoice facts", () => {
  const prompt = buildInvoiceStyleExamples([{ original_body: "Draft A", edited_body: "My edit" }]);
  assert(prompt.includes('"userEdit":"My edit"'));
  assert(prompt.includes("Do not copy invoice facts"));
});
