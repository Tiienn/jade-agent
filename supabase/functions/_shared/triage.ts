// Inbox triage — pure rules, no network, no model call.
//
// This is what keeps the email assistant cheap and predictable: the great
// majority of an inbox is newsletters, system notifications and all-staff
// broadcasts, and none of that needs an LLM to recognise. Only what survives
// triage as 'action' is ever sent to OpenAI for drafting.
//
// Every decision carries a plain-English `reason`, because the UI shows it back
// to the user ("Newsletter or marketing", "You were only copied"). A reason
// that reads like a rule name is a bug — he should be able to disagree with the
// call and understand why it was made.
//
// Deliberately pure and dependency-free so it can be unit-tested exhaustively —
// see triage_test.ts. Nothing in here may import graph, supabase, or env.

export type Triage = "action" | "fyi" | "ignore";

export interface TriageInput {
  fromEmail: string;
  fromName: string;
  subject: string;
  toRecipients: string[];
  ccRecipients: string[];
  bodyPreview: string;
  ownerEmail: string;
  rules: { pattern: string; action: "ignore" | "prioritise" }[];
}

export interface TriageResult {
  triage: Triage;
  reason: string;
}

/**
 * Machine phrases that can appear ANYWHERE in the local-part, once separators
 * are stripped. Real senders observed in the wild include
 * `microsoft-noreply@microsoft.com`, which an exact-match list misses entirely.
 * Only unambiguous phrases live here — no human is called "noreply".
 */
const AUTOMATED_CONTAINS = [
  "noreply",
  "donotreply",
  "mailerdaemon",
  "postmaster",
];

/**
 * Local-parts that mean "a machine sent this", matched EXACTLY. These words can
 * legitimately appear inside a person's address (`bounce.smith@…`,
 * `notification.dept@…`), so they must not be matched as substrings.
 */
const AUTOMATED_LOCAL_PARTS = new Set([
  "notifications",
  "notification",
  "bounce",
  "automated",
]);

/**
 * Conventional mailbox names for bulk senders. Exact match — a person could be
 * `newsome@…` but nobody is called `news`.
 */
const BULK_LOCAL_PARTS = new Set([
  "news",
  "newsletter",
  "newsletters",
  "marketing",
  "promo",
  "promotions",
  "offers",
  "deals",
  "digest",
  "campaign",
  "mailing",
  "unsubscribe",
]);

/**
 * Sending subdomains. Bulk mail is almost always sent from a dedicated
 * subdomain (`info@sales.alibaba.com`, `messaging-service@post.xero.com`) so
 * that marketing complaints never poison the company's main sending domain.
 * Only applied when the domain has 3+ labels, so `news.mu` stays untouched.
 */
const BULK_SUBDOMAINS = new Set([
  "news",
  "mail",
  "email",
  "e",
  "em",
  "mktg",
  "marketing",
  "sales",
  "order",
  "orders",
  "deals",
  "promo",
  "notify",
  "alerts",
  "post",
  "list",
  "campaign",
  "reply",
]);

/** Company-wide distribution lists. Never a personal ask. */
const BROADCAST_PREFIX = "allstaff@";

/**
 * Phrases that only appear in bulk mail. Checked against subject + preview
 * together, since some newsletters carry the giveaway in one and not the other.
 */
const BULK_MARKERS = [
  "unsubscribe",
  "view online",
  "view in browser",
  "newsletter",
  "privacy policy",
  "you are receiving this",
];

function norm(s: string): string {
  return (s ?? "").trim().toLowerCase();
}

function localPartOf(address: string): string {
  const a = norm(address);
  const at = a.lastIndexOf("@");
  return at < 0 ? a : a.slice(0, at);
}

function domainOf(address: string): string {
  const a = norm(address);
  const at = a.lastIndexOf("@");
  return at < 0 ? "" : a.slice(at + 1);
}

function includesAddress(list: string[], address: string): boolean {
  const target = norm(address);
  if (!target) return false;
  return (list ?? []).some((r) => norm(r) === target);
}

/**
 * Does a user rule pattern match this sender?
 *
 * A pattern is either a full address (`hello@propertycloud.mu`) or a bare
 * domain (`propertycloud.mu`). A bare domain matches any sender at that domain;
 * it is not treated as a suffix wildcard, so `cloud.mu` does not match
 * `propertycloud.mu`.
 */
function ruleMatches(pattern: string, fromEmail: string): boolean {
  const p = norm(pattern);
  if (!p) return false;
  const from = norm(fromEmail);
  if (!from) return false;
  if (p.includes("@")) return p === from;
  return domainOf(from) === p;
}

/**
 * Classify one message. First matching rule wins; the order below is the
 * policy, so read it top to bottom.
 */
export function triage(input: TriageInput): TriageResult {
  const fromEmail = norm(input.fromEmail);
  const to = input.toRecipients ?? [];
  const cc = input.ccRecipients ?? [];

  // 1. The user's own rules beat every heuristic. If he has said "always ignore
  //    this sender", or "this one always matters", that is the answer — even
  //    for a sender the heuristics below would have classified differently.
  for (const rule of input.rules ?? []) {
    if (!ruleMatches(rule.pattern, fromEmail)) continue;
    if (rule.action === "ignore") {
      return { triage: "ignore", reason: "You chose to ignore this sender" };
    }
    return { triage: "action", reason: "You marked this sender as important" };
  }

  // 2. Machine senders. Nothing to reply to — there is no one at the other end.
  const local = localPartOf(fromEmail);
  // Strip separators so `microsoft-noreply` and `no-reply` both normalise to a
  // string containing "noreply".
  const localSquashed = local.replace(/[.\-_+]/g, "");
  if (
    AUTOMATED_LOCAL_PARTS.has(local) ||
    AUTOMATED_CONTAINS.some((p) => localSquashed.includes(p))
  ) {
    return { triage: "ignore", reason: "Automated sender" };
  }

  if (BULK_LOCAL_PARTS.has(local)) {
    return { triage: "ignore", reason: "Newsletter or marketing" };
  }

  // Dedicated sending subdomain, e.g. sales.alibaba.com or post.xero.com.
  const domainLabels = domainOf(fromEmail).split(".");
  if (domainLabels.length >= 3 && BULK_SUBDOMAINS.has(domainLabels[0])) {
    return { triage: "ignore", reason: "Bulk sending address" };
  }

  // 3. All-staff broadcasts. Addressed to everyone means addressed to no one.
  const allRecipients = [...to, ...cc];
  if (allRecipients.some((r) => norm(r).startsWith(BROADCAST_PREFIX))) {
    return { triage: "ignore", reason: "Sent to all staff" };
  }

  // 4. Bulk and marketing. Checked before the addressed-to-you rules on
  //    purpose: a newsletter is still a newsletter when it is sent to him by
  //    name, which is exactly how mailing lists address people.
  const haystack = `${norm(input.subject)} ${norm(input.bodyPreview)}`;
  if (BULK_MARKERS.some((m) => haystack.includes(m))) {
    return { triage: "ignore", reason: "Newsletter or marketing" };
  }

  // 5. Not in the To line. Being copied is information; being neither is noise.
  if (!includesAddress(to, input.ownerEmail)) {
    if (includesAddress(cc, input.ownerEmail)) {
      return { triage: "fyi", reason: "You were only copied" };
    }
    return { triage: "ignore", reason: "Not addressed to you" };
  }

  // 6. A person wrote to him directly.
  return { triage: "action", reason: "Addressed to you directly" };
}
