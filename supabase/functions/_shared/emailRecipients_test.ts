import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { parseEmailRecipients, parseRecipientGroups } from "./emailRecipients.ts";

Deno.test("parses multiple recipient separators and removes duplicates", () => {
  assertEquals(
    parseEmailRecipients("client@example.com, accounts@example.com; CLIENT@example.com\nowner@example.com"),
    ["CLIENT@example.com", "accounts@example.com", "owner@example.com"],
  );
});

Deno.test("rejects an invalid recipient", () => {
  assertThrows(
    () => parseEmailRecipients("client@example.com, not-an-email"),
    Error,
    "not-an-email is not a valid email address.",
  );
});

Deno.test("rejects an empty recipient list", () => {
  assertThrows(
    () => parseEmailRecipients(" , ; \n"),
    Error,
    "Enter at least one client email address.",
  );
});

Deno.test("parses To, Cc and Bcc and removes cross-field duplicates", () => {
  assertEquals(
    parseRecipientGroups(
      "client@example.com, owner@example.com",
      "accounts@example.com, CLIENT@example.com",
      "private@example.com, accounts@example.com",
    ),
    {
      to: ["client@example.com", "owner@example.com"],
      cc: ["accounts@example.com"],
      bcc: ["private@example.com"],
    },
  );
});

Deno.test("allows empty Cc and Bcc fields", () => {
  assertEquals(parseRecipientGroups("client@example.com", "", ""), {
    to: ["client@example.com"],
    cc: [],
    bcc: [],
  });
});

Deno.test("enforces the recipient limit across all three fields", () => {
  assertThrows(
    () => parseRecipientGroups(
      "one@example.com, two@example.com",
      "three@example.com",
      "four@example.com",
      3,
    ),
    Error,
    "Add no more than 3 total recipients across To, Cc and Bcc.",
  );
});
