// Microsoft Graph mail client — DELEGATED access.
//
// This is deliberately separate from graph.ts. That module uses an APP-ONLY
// (client-credentials) token, which is correct for SharePoint: one service
// identity reading a shared document library. It is the wrong thing for mail.
// An app-only Mail.ReadWrite grant reaches EVERY mailbox in the tenant, and the
// only thing standing between the agent and a colleague's inbox would be an
// Exchange application access policy we configured correctly and never broke.
//
// So mail uses delegated OAuth instead: the user signs in once, consents, and
// we store their refresh token. Background jobs mint short-lived access tokens
// from it. The resulting token carries that user's identity, so `/me/...` is
// the only mailbox it can ever address — enforced by Microsoft, not by our
// configuration. Nothing here should ever be pointed at `/users/{id}/...`.
//
// Do not add app-only helpers to this file, and do not add delegated helpers to
// graph.ts. Keeping the two token models in separate modules is the point.

import { HttpError } from "./auth.ts";

const GRAPH = "https://graph.microsoft.com/v1.0";

/**
 * Delegated scopes. Mail.Send is used only by graphNotification.ts for the
 * fixed-recipient L'Express lead digest. The normal email assistant below
 * still has no send helper: replies and leave notices remain drafts that a
 * person reviews in Outlook.
 */
export const MAIL_SCOPES = "offline_access Mail.ReadWrite Mail.Send User.Read";

/**
 * The OAuth redirect URI.
 *
 * Microsoft compares this string three ways — against the value registered in
 * Azure, against the one on the authorize request, and against the one on the
 * token exchange — and rejects the whole flow if any of them differ by a single
 * character. mail-connect and mail-callback therefore both call this rather
 * than each writing it out.
 */
export function mailRedirectUri(): string {
  return `${reqEnv("SUPABASE_URL")}/functions/v1/mail-callback`;
}

// Shared by every message-listing call below, so a property added here reaches
// listInboxSince, listMessagesFromSender and getMessageWithBody at once.
//
// `internetMessageId` is the RFC 5322 Message-ID. It is here because `id` is
// not enough to identify an ANNOUNCEMENT: Graph's `id` is per-mailbox, so one
// all-staff mail carries a different `id` in every recipient's inbox. See the
// comment on staff_presence.source_message_id in migration 0008.
//
// (The warning elsewhere in this codebase that $select makes Graph drop
// `@microsoft.graph.downloadUrl` is about DRIVE items. It does not apply to
// messages, and does not stop us selecting narrowly here.)
const MESSAGE_SELECT = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "receivedDateTime",
  "bodyPreview",
  "webLink",
  "isRead",
].join(",");

/** Pages of inbox messages to follow per sync. See listInboxSince. */
const MAX_PAGES = 5;

/**
 * Pages to follow per announcer during a presence backfill. Higher than
 * MAX_PAGES because a backfill deliberately reaches months back, and lower than
 * unbounded because it runs inside one HTTP request an admin is waiting on.
 */
const BACKFILL_MAX_PAGES = 12;

function reqEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new HttpError(
      500,
      `Mailbox access not configured — see EMAIL-SETUP.md (missing ${name})`,
    );
  }
  return v;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MailMessage {
  /** Graph's own id. Per MAILBOX — two people holding the same mail hold two. */
  id: string;
  /**
   * The RFC 5322 Message-ID, stamped by the sending server and therefore the
   * SAME string in every recipient's copy. Null when the sender omitted it,
   * which is malformed but not impossible — callers that use it as an identity
   * must cope. See presenceSource in presenceStore.ts.
   */
  internetMessageId: string | null;
  conversationId: string | null;
  subject: string;
  fromEmail: string;
  fromName: string;
  toRecipients: string[];
  ccRecipients: string[];
  receivedAt: string | null;
  bodyPreview: string;
  webLink: string | null;
  isRead: boolean;
}

export interface MailMessageWithBody extends MailMessage {
  /** Full message body — used for drafting context only, never persisted. */
  body: { content: string; contentType: string };
}

export interface TokenPair {
  accessToken: string;
  /**
   * Microsoft MAY return a rotated refresh token on any refresh. When it does,
   * the old one is on its way to being invalid. See accessTokenFromRefresh.
   */
  refreshToken?: string;
}

export interface ConnectResult {
  accessToken: string;
  refreshToken: string;
  email: string;
}

/** Small file attachment accepted by Microsoft Graph's JSON attachment API. */
export interface DraftAttachment {
  name: string;
  contentType: string;
  /** Raw file bytes. They are encoded only for the request to Microsoft. */
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return "";
  }
}

async function throwGraph(res: Response): Promise<never> {
  const detail = await safeText(res);
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(
      502,
      `Microsoft Graph denied the request (${res.status}). The mailbox ` +
        `connection may have expired or been revoked — reconnect your mailbox ` +
        `from the Email page. ${detail}`,
      "mailbox_reconnect",
    );
  }
  throw new HttpError(502, `Microsoft Graph error (${res.status}). ${detail}`);
}

async function graphGet(
  accessToken: string,
  url: string,
  extraHeaders: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(
    url.startsWith("http") ? url : `${GRAPH}${url}`,
    {
      headers: { Authorization: `Bearer ${accessToken}`, ...extraHeaders },
    },
  );
  if (!res.ok) await throwGraph(res);
  return res.json();
}

// ---------------------------------------------------------------------------
// OAuth — authorization code + refresh
// ---------------------------------------------------------------------------

function tokenEndpoint(): string {
  return `https://login.microsoftonline.com/${
    reqEnv("MS_TENANT_ID")
  }/oauth2/v2.0/token`;
}

async function postToken(body: URLSearchParams): Promise<any> {
  const res = await fetch(tokenEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new HttpError(
      502,
      `Microsoft sign-in failed (${res.status}). The mailbox connection may ` +
        `need to be re-authorised from the Email page. ${detail}`,
      "mailbox_reconnect",
    );
  }
  return res.json();
}

/**
 * Exchange the authorization code from the OAuth redirect for tokens, and
 * resolve which mailbox was actually connected by asking `/me`.
 *
 * `redirectUri` must be byte-identical to the one used on the authorize
 * request, or Microsoft rejects the exchange.
 */
export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
): Promise<ConnectResult> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: reqEnv("MS_CLIENT_ID"),
      client_secret: reqEnv("MS_CLIENT_SECRET"),
      code,
      redirect_uri: redirectUri,
      scope: MAIL_SCOPES,
    }),
  );

  const accessToken = json.access_token as string | undefined;
  const refreshToken = json.refresh_token as string | undefined;
  if (!accessToken || !refreshToken) {
    // No refresh token means `offline_access` was not granted; without it the
    // connection would work once and then silently stop.
    throw new HttpError(
      502,
      "Microsoft did not return a refresh token. Check that the offline_access scope is granted.",
      "mailbox_reconnect",
    );
  }

  const me = await graphGet(
    accessToken,
    "/me?$select=mail,userPrincipalName",
  );
  const email = (me.mail ?? me.userPrincipalName ?? "") as string;

  return { accessToken, refreshToken, email };
}

/**
 * Mint an access token from a stored refresh token.
 *
 * !! IMPORTANT — REFRESH TOKEN ROTATION !!
 * Microsoft may hand back a NEW refresh token on any call, and when it does the
 * one you sent is on a short fuse. If the caller drops the rotated value and
 * keeps using the old one, everything keeps working for a while and then the
 * connection dies — days later, with no user action to correlate it to, and the
 * only symptom is a background sync quietly failing with invalid_grant.
 *
 * Therefore: EVERY caller MUST persist `refreshToken` to mail_accounts whenever
 * it is present. There is no scenario in which discarding it is correct.
 */
export async function accessTokenFromRefresh(
  refreshToken: string,
): Promise<TokenPair> {
  const json = await postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: reqEnv("MS_CLIENT_ID"),
      client_secret: reqEnv("MS_CLIENT_SECRET"),
      refresh_token: refreshToken,
      scope: MAIL_SCOPES,
    }),
  );

  const accessToken = json.access_token as string | undefined;
  if (!accessToken) {
    throw new HttpError(
      502,
      "Microsoft returned no access token. Reconnect the mailbox from the Email page.",
      "mailbox_reconnect",
    );
  }
  // Only surface a rotated token when it actually changed, so callers can skip
  // a pointless write on the common path.
  const rotated = json.refresh_token as string | undefined;
  return {
    accessToken,
    refreshToken: rotated && rotated !== refreshToken ? rotated : undefined,
  };
}

// ---------------------------------------------------------------------------
// Reading mail
// ---------------------------------------------------------------------------

function addressesOf(recipients: any): string[] {
  if (!Array.isArray(recipients)) return [];
  return recipients
    .map((r) => String(r?.emailAddress?.address ?? "").trim())
    .filter(Boolean);
}

function mapMessage(m: any): MailMessage {
  return {
    id: String(m.id ?? ""),
    // Empty collapses to null so callers have one "absent" to test, not two.
    internetMessageId: String(m.internetMessageId ?? "").trim() || null,
    conversationId: m.conversationId ?? null,
    subject: m.subject ?? "",
    fromEmail: String(m.from?.emailAddress?.address ?? "").trim(),
    fromName: String(m.from?.emailAddress?.name ?? "").trim(),
    toRecipients: addressesOf(m.toRecipients),
    ccRecipients: addressesOf(m.ccRecipients),
    receivedAt: m.receivedDateTime ?? null,
    bodyPreview: m.bodyPreview ?? "",
    webLink: m.webLink ?? null,
    isRead: !!m.isRead,
  };
}

/**
 * Inbox messages received at or after `sinceIso`, newest first.
 *
 * Follows `@odata.nextLink` up to {@link MAX_PAGES} pages. The cap is a runaway
 * guard: a first sync on a busy mailbox could otherwise page for a long time,
 * and a sync that returns the most recent N messages is always more useful than
 * one that times out. The caller records last_sync_at from what it processed,
 * so a truncated run just means the next run starts where this one stopped.
 */
export async function listInboxSince(
  accessToken: string,
  sinceIso: string,
  top = 50,
): Promise<MailMessage[]> {
  const filter = `receivedDateTime ge ${sinceIso}`;
  let url = `${GRAPH}/me/mailFolders/inbox/messages` +
    `?$select=${MESSAGE_SELECT}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$orderby=${encodeURIComponent("receivedDateTime desc")}` +
    `&$top=${top}`;

  const items: any[] = [];
  let pages = 0;
  while (url && pages < MAX_PAGES) {
    const json = await graphGet(accessToken, url);
    for (const m of json.value ?? []) items.push(m);
    url = json["@odata.nextLink"] ?? "";
    pages += 1;
  }
  return items.map(mapMessage);
}

/**
 * One message including its full body, for drafting context.
 *
 * The body is the only place the actual content of an email is ever handled.
 * It is passed to the drafting model and discarded — never written to the
 * database (email_messages has no body column, deliberately).
 */
export async function getMessageWithBody(
  accessToken: string,
  id: string,
): Promise<MailMessageWithBody> {
  const json = await graphGet(
    accessToken,
    `/me/messages/${encodeURIComponent(id)}?$select=${MESSAGE_SELECT},body`,
  );
  return {
    ...mapMessage(json),
    body: {
      content: json.body?.content ?? "",
      contentType: json.body?.contentType ?? "text",
    },
  };
}

/**
 * Just the body text of one message, as plain text.
 *
 * Exists because `bodyPreview` — the only body-ish field listInboxSince selects
 * — is capped by Graph at roughly 255 characters. That is fine for triage,
 * which only sniffs for keywords, and useless for presence extraction: the
 * multi-person notices are a bulleted list, and 255 characters reaches the
 * second bullet. Reading the truncated preview would silently file two of the
 * four people named and leave the rest at their desks on the board.
 *
 * `Prefer: outlook.body-content-type="text"` asks Exchange to do the HTML
 * flattening server-side, which it does far better than a regex can. Outlook
 * still returns HTML for some messages, so the crude fallback below stands in
 * — it only has to be good enough for the sentence-level parsing in
 * presence.ts, which reads lines and bullets and ignores everything else.
 *
 * Returns TEXT, not a message: nothing about this body should end up in a row.
 * Callers extract from it and let it go out of scope. See the header comment in
 * mail-sync — email_messages has no body column, deliberately.
 */
export async function getMessageBody(
  accessToken: string,
  messageId: string,
): Promise<string> {
  const json = await graphGet(
    accessToken,
    `/me/messages/${encodeURIComponent(messageId)}?$select=body`,
    { Prefer: 'outlook.body-content-type="text"' },
  );
  const content = String(json?.body?.content ?? "");
  const type = String(json?.body?.contentType ?? "text").toLowerCase();
  return type === "html" ? htmlToText(content) : content;
}

/** Crude HTML flattening — see getMessageBody for why crude is enough. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    // Block-level closers become newlines so a bulleted absence list survives
    // as one line per person, which is exactly what splitClauses expects.
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** OData string literals escape a single quote by doubling it. */
function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Messages from one sender since `sinceIso`, across ALL folders.
 *
 * For the presence backfill, not for sync. Two deliberate differences from
 * listInboxSince:
 *
 *   * `/me/messages` rather than the inbox, because a backfill reaches months
 *     back and by then the notices have usually been filed or archived. An
 *     absence announcement that was moved out of the inbox still happened.
 *   * NO `$orderby`. Exchange rejects the combination of a `from` filter with
 *     an ordering on a different property ("The restriction or sort order is
 *     too complex"), and losing the order costs nothing here: the caller
 *     examines every message it gets rather than taking the newest N.
 *
 * Paging stops at `max` messages or {@link BACKFILL_MAX_PAGES}, whichever comes
 * first, so a chatty announcer cannot turn one backfill into an unbounded walk
 * of the mailbox.
 */
export async function listMessagesFromSender(
  accessToken: string,
  fromEmail: string,
  sinceIso: string,
  max: number,
): Promise<MailMessage[]> {
  const filter = `receivedDateTime ge ${sinceIso} and ` +
    `from/emailAddress/address eq ${odataString(fromEmail.trim().toLowerCase())}`;
  let url = `${GRAPH}/me/messages` +
    `?$select=${MESSAGE_SELECT}` +
    `&$filter=${encodeURIComponent(filter)}` +
    `&$top=${Math.min(Math.max(max, 1), 50)}`;

  const items: any[] = [];
  let pages = 0;
  while (url && pages < BACKFILL_MAX_PAGES && items.length < max) {
    const json = await graphGet(accessToken, url);
    for (const m of json.value ?? []) items.push(m);
    url = json["@odata.nextLink"] ?? "";
    pages += 1;
  }
  return items.slice(0, max).map(mapMessage);
}

// ---------------------------------------------------------------------------
// Writing drafts
// ---------------------------------------------------------------------------

/**
 * Create a reply draft in the user's Drafts folder and return its id.
 *
 * Two calls: `createReply` gives us a draft that already carries the correct
 * recipients, subject and quoted thread; we then PATCH only its body so our
 * text sits where he would have typed it.
 *
 * !! There is no send function in this module, and there must never be one. !!
 * The whole design is that a human presses Send in Outlook. The separate lead
 * notifier has a narrow send path, but incoming mailbox text never reaches it.
 * Adding a send helper here would let prompt-injected email text cross that
 * boundary. Don't.
 */
export async function createReplyDraft(
  accessToken: string,
  messageId: string,
  bodyHtml: string,
): Promise<string> {
  const createRes = await fetch(
    `${GRAPH}/me/messages/${encodeURIComponent(messageId)}/createReply`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
  );
  if (!createRes.ok) await throwGraph(createRes);
  const draft = await createRes.json();
  const draftId = String(draft.id ?? "");
  if (!draftId) {
    throw new HttpError(502, "Microsoft Graph returned a draft with no id.");
  }

  const patchRes = await fetch(
    `${GRAPH}/me/messages/${encodeURIComponent(draftId)}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: { contentType: "HTML", content: bodyHtml },
      }),
    },
  );
  if (!patchRes.ok) await throwGraph(patchRes);
  await patchRes.body?.cancel();

  return draftId;
}

/**
 * Create a NEW (unthreaded) draft in the user's Drafts folder and return its id.
 *
 * `createReplyDraft` above cannot serve this: Graph's `/createReply` needs an
 * existing message to hang the reply on, and a leave confirmation or an
 * all-staff absence notice answers nothing — it starts a thread. So this POSTs
 * the whole message to `/me/messages`, which Graph files as a draft because no
 * send is requested.
 *
 * Recipients are passed as plain addresses and mapped into Graph's shape here,
 * so callers never hand-build `emailAddress` objects and cannot accidentally
 * put an address in the wrong field.
 *
 * !! The same rule as above applies, and matters more here. !!
 * There is no send function in this module and there must never be one. A reply
 * draft at least requires a real message someone sent us; THIS function can
 * address anyone, so it would be the obvious place to "just add a send". The
 * The separate L'Express notifier holds Mail.Send but this module deliberately
 * exposes no send helper. A human still opens Outlook and presses Send for
 * every draft created here.
 */
export async function createNewDraft(
  accessToken: string,
  to: string[],
  subject: string,
  bodyHtml: string,
  attachments: DraftAttachment[] = [],
  cc: string[] = [],
  bcc: string[] = [],
): Promise<string> {
  const recipientsOf = (addresses: string[]) => addresses
    .map((address) => address.trim())
    .filter((address) => address.length > 0)
    .map((address) => ({ emailAddress: { address } }));

  const recipients = recipientsOf(to);

  if (recipients.length === 0) {
    // Graph would happily store a draft addressed to nobody. Refusing here is
    // kinder than a silent no-op: the caller has lost a recipient somewhere
    // (most often a roster entry with no email), and that is worth surfacing
    // rather than discovering later as a confirmation that never arrived.
    throw new HttpError(400, "Cannot create a draft with no recipients.");
  }

  const res = await fetch(`${GRAPH}/me/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject,
      body: { contentType: "HTML", content: bodyHtml },
      toRecipients: recipients,
      ccRecipients: recipientsOf(cc),
      bccRecipients: recipientsOf(bcc),
      attachments: attachments.map((attachment) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.name,
        contentType: attachment.contentType,
        isInline: false,
        contentBytes: bytesToBase64(attachment.bytes),
      })),
    }),
  });
  if (!res.ok) await throwGraph(res);

  const draft = await res.json();
  const draftId = String(draft.id ?? "");
  if (!draftId) {
    throw new HttpError(502, "Microsoft Graph returned a draft with no id.");
  }
  return draftId;
}

/** Encode without spreading a multi-megabyte array onto the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
