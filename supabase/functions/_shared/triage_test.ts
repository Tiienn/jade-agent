// Deno tests for the pure triage rules.
// Run: deno test supabase/functions/_shared/triage_test.ts
//
// Fixtures are modelled on real traffic in Stephan's mailbox — the property
// newsletter, the all-staff leave notices, the Xero billing robot, and the
// tender threads that actually matter. The last of those is the one that must
// never regress: a genuine colleague email has to come out as 'action'.

import { assertEquals } from "jsr:@std/assert@1";
import { triage, type TriageInput } from "./triage.ts";

const OWNER = "Stephan.AhThien@jadegroup.mu";

function msg(over: Partial<TriageInput> = {}): TriageInput {
  return {
    fromEmail: "someone@example.com",
    fromName: "Someone",
    subject: "Hello",
    toRecipients: [OWNER],
    ccRecipients: [],
    bodyPreview: "",
    ownerEmail: OWNER,
    rules: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Rule 1 — user rules
// ---------------------------------------------------------------------------

Deno.test("user rule: exact address ignore", () => {
  const r = triage(msg({
    fromEmail: "hello@propertycloud.mu",
    subject: "Mauritius property update",
    rules: [{ pattern: "hello@propertycloud.mu", action: "ignore" }],
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "You chose to ignore this sender");
});

Deno.test("user rule: bare domain ignore matches any sender at that domain", () => {
  const r = triage(msg({
    fromEmail: "messaging-service@post.xero.com",
    subject: "Invoice INV-0042 from Jade Group",
    rules: [{ pattern: "post.xero.com", action: "ignore" }],
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "You chose to ignore this sender");
});

Deno.test("user rule: prioritise promotes to action", () => {
  const r = triage(msg({
    fromEmail: "quotes@northernprint.mu",
    subject: "Roll up banner quote",
    toRecipients: ["someoneelse@jadegroup.mu"],
    ccRecipients: [],
    rules: [{ pattern: "quotes@northernprint.mu", action: "prioritise" }],
  }));
  assertEquals(r.triage, "action");
  assertEquals(r.reason, "You marked this sender as important");
});

Deno.test("user rule beats the automated-sender rule (precedence)", () => {
  // A robot he actually wants to see — the rule must win over rule 2.
  const r = triage(msg({
    fromEmail: "notifications@bankonline.mu",
    subject: "Payment received",
    rules: [{ pattern: "notifications@bankonline.mu", action: "prioritise" }],
  }));
  assertEquals(r.triage, "action");
});

Deno.test("user rule beats a direct email from a colleague (precedence)", () => {
  const r = triage(msg({
    fromEmail: "Melanie.Lau@jadegroup.mu",
    subject: "RE: Signage",
    rules: [{ pattern: "melanie.lau@jadegroup.mu", action: "ignore" }],
  }));
  assertEquals(r.triage, "ignore");
});

Deno.test("user rule matching is case-insensitive both ways", () => {
  const r = triage(msg({
    fromEmail: "HELLO@PropertyCloud.MU",
    rules: [{ pattern: "  Hello@propertycloud.mu  ", action: "ignore" }],
  }));
  assertEquals(r.triage, "ignore");
});

Deno.test("bare-domain rule is not a suffix wildcard", () => {
  // 'cloud.mu' must not swallow 'propertycloud.mu'.
  const r = triage(msg({
    fromEmail: "hello@propertycloud.mu",
    subject: "Site visit Thursday",
    rules: [{ pattern: "cloud.mu", action: "ignore" }],
  }));
  assertEquals(r.triage, "action");
  assertEquals(r.reason, "Addressed to you directly");
});

// ---------------------------------------------------------------------------
// Rule 2 — automated senders
// ---------------------------------------------------------------------------

Deno.test("automated sender: no-reply is ignored", () => {
  const r = triage(msg({
    fromEmail: "no-reply@sharepointonline.com",
    subject: "A file was shared with you",
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Automated sender");
});

Deno.test("automated sender: every listed local-part is caught", () => {
  const locals = [
    "noreply",
    "no-reply",
    "donotreply",
    "do-not-reply",
    "notifications",
    "notification",
    "mailer-daemon",
    "postmaster",
    "bounce",
    "automated",
  ];
  for (const local of locals) {
    const r = triage(msg({ fromEmail: `${local}@service.example.com` }));
    assertEquals(r.triage, "ignore", `${local} should be ignored`);
    assertEquals(r.reason, "Automated sender");
  }
});

Deno.test("automated match is on the whole local-part, not a substring", () => {
  // A real person whose address merely contains one of the words.
  const r = triage(msg({
    fromEmail: "bounce.smith@contractor.mu",
    subject: "Site measurements",
  }));
  assertEquals(r.triage, "action");
});

// ---------------------------------------------------------------------------
// Rule 3 — all-staff broadcasts
// ---------------------------------------------------------------------------

Deno.test("all-staff broadcast is ignored (real: half sick leave notice)", () => {
  const r = triage(msg({
    fromEmail: "melanie.lau@jadegroup.mu",
    fromName: "Melanie Lau",
    subject: "Reshad is on half sick leave PM",
    toRecipients: ["Allstaff@jadegroup.mu"],
    bodyPreview: "Please note that Reshad will not be available this afternoon.",
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Sent to all staff");
});

Deno.test("all-staff on the Cc line is still a broadcast", () => {
  const r = triage(msg({
    fromEmail: "melanie.lau@jadegroup.mu",
    subject: "Office closed Friday",
    toRecipients: [OWNER],
    ccRecipients: ["allstaff@jadegroup.mu"],
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Sent to all staff");
});

// ---------------------------------------------------------------------------
// Rule 4 — bulk / marketing
// ---------------------------------------------------------------------------

Deno.test("newsletter is ignored even when addressed to him by name", () => {
  const r = triage(msg({
    fromEmail: "hello@propertycloud.mu",
    fromName: "PropertyCloud",
    subject: "The PropertyCloud Newsletter — August",
    toRecipients: [OWNER],
    bodyPreview: "Top listings this month. View in browser.",
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Newsletter or marketing");
});

Deno.test("bulk markers are matched in the preview too, case-insensitively", () => {
  const markers = [
    "Click here to Unsubscribe",
    "View Online",
    "View In Browser",
    "Our monthly Newsletter",
    "See our Privacy Policy",
    "You Are Receiving This because you signed up",
  ];
  for (const preview of markers) {
    const r = triage(msg({
      fromEmail: "marketing@vendor.example.com",
      subject: "Offers",
      bodyPreview: preview,
    }));
    assertEquals(r.triage, "ignore", `"${preview}" should be bulk`);
    assertEquals(r.reason, "Newsletter or marketing");
  }
});

// ---------------------------------------------------------------------------
// Rule 5 — addressing
// ---------------------------------------------------------------------------

Deno.test("cc-only lands as fyi", () => {
  const r = triage(msg({
    fromEmail: "Charles.Li@jadegroup.mu",
    subject: "RE: Manhattan facade signage",
    toRecipients: ["Ashwiny.Appadoo@jadegroup.mu"],
    ccRecipients: [OWNER],
  }));
  assertEquals(r.triage, "fyi");
  assertEquals(r.reason, "You were only copied");
});

Deno.test("cc-only matching ignores case and surrounding spaces", () => {
  const r = triage(msg({
    fromEmail: "Charles.Li@jadegroup.mu",
    toRecipients: ["kelly.chan@jadegroup.mu"],
    ccRecipients: ["  stephan.ahthien@JADEGROUP.mu "],
  }));
  assertEquals(r.triage, "fyi");
});

Deno.test("not addressed to him at all is ignored", () => {
  const r = triage(msg({
    fromEmail: "vincent.fonsing@jadegroup.mu",
    subject: "Lease renewal",
    toRecipients: ["nisha.ortoo@jadegroup.mu"],
    ccRecipients: ["meera.beedassy@jadegroup.mu"],
  }));
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Not addressed to you");
});

Deno.test("in To alongside others is still action", () => {
  const r = triage(msg({
    fromEmail: "Charles.Li@jadegroup.mu",
    subject: "Fact sheets",
    toRecipients: ["kelly.chan@jadegroup.mu", OWNER],
    ccRecipients: ["meera.beedassy@jadegroup.mu"],
  }));
  assertEquals(r.triage, "action");
  assertEquals(r.reason, "Addressed to you directly");
});

// ---------------------------------------------------------------------------
// Rule 6 — the one that must never regress
// ---------------------------------------------------------------------------

Deno.test("genuine colleague email is action (real: RE: Tender Sicom-FSB)", () => {
  const r = triage(msg({
    fromEmail: "Charles.Li@jadegroup.mu",
    fromName: "Charles Li",
    subject: "RE: Tender Sicom-FSB",
    toRecipients: ["Stephan.AhThien@jadegroup.mu"],
    ccRecipients: [],
    bodyPreview: "Can you send me the updated floor areas before Friday?",
  }));
  assertEquals(r.triage, "action");
  assertEquals(r.reason, "Addressed to you directly");
});

Deno.test("a real vendor reply addressed to him is action", () => {
  const r = triage(msg({
    fromEmail: "sales@northernprint.mu",
    fromName: "Northern Print",
    subject: "RE: Roll up banner",
    bodyPreview: "We have 85x200 and 100x200 in stock. Prices attached.",
  }));
  assertEquals(r.triage, "action");
  assertEquals(r.reason, "Addressed to you directly");
});

Deno.test("empty rules and missing recipient arrays do not throw", () => {
  const r = triage({
    fromEmail: "charles.li@jadegroup.mu",
    fromName: "Charles Li",
    subject: "",
    toRecipients: [],
    ccRecipients: [],
    bodyPreview: "",
    ownerEmail: OWNER,
    rules: [],
  });
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Not addressed to you");
});

// ---------------------------------------------------------------------------
// Regressions from the first live sync against Stephan's real inbox (Aug 2026).
// Each of these was wrongly classified as 'action' and had to be seen in
// production to be found — keep them as fixtures so they cannot come back.
// ---------------------------------------------------------------------------


function live(fromEmail: string, subject: string) {
  return triage({
    fromEmail,
    fromName: "",
    subject,
    toRecipients: [OWNER],
    ccRecipients: [],
    bodyPreview: "",
    ownerEmail: OWNER,
    rules: [],
  });
}

Deno.test("regression: microsoft-noreply is automated despite the prefix", () => {
  const r = live(
    "microsoft-noreply@microsoft.com",
    "Passkeys by default and retirement of Microsoft-provided SMS",
  );
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Automated sender");
});

Deno.test("regression: news@ is a newsletter mailbox", () => {
  const r = live("news@lexpressproperty.com", "Nouveau magazine : Changer de decor");
  assertEquals(r.triage, "ignore");
});

Deno.test("regression: bulk sending subdomain sales.alibaba.com", () => {
  const r = live("info@sales.alibaba.com", "Local inventory in Europe");
  assertEquals(r.triage, "ignore");
  assertEquals(r.reason, "Bulk sending address");
});

Deno.test("regression: post.xero.com is a sending subdomain", () => {
  const r = live("messaging-service@post.xero.com", "Invoice MM-INV-2169");
  assertEquals(r.triage, "ignore");
});

Deno.test("a person whose name contains a machine word is NOT filtered", () => {
  // The exact-match list exists precisely to protect these.
  assertEquals(live("bounce.smith@acme.com", "Quote for signage").triage, "action");
  assertEquals(live("newsome@acme.com", "Re: site visit").triage, "action");
});

Deno.test("real colleagues still reach action after the new rules", () => {
  assertEquals(
    live("Charles.Li@jadegroup.mu", "RE: Documents for coignet walk").triage,
    "action",
  );
  assertEquals(
    live("meera.beedassy@jadegroup.mu", "RE: Parking plan at SCT").triage,
    "action",
  );
});

Deno.test("two-label domain named news.mu is not treated as a subdomain", () => {
  assertEquals(live("editor@news.mu", "Interview request").triage, "action");
});
