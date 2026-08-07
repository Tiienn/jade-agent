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

/** Delegated scopes. `Mail.Send` is absent on purpose — see createReplyDraft. */
export const MAIL_SCOPES = "offline_access Mail.ReadWrite User.Read";

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

const MESSAGE_SELECT = [
  "id",
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
  id: string;
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

async function graphGet(accessToken: string, url: string): Promise<any> {
  const res = await fetch(
    url.startsWith("http") ? url : `${GRAPH}${url}`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
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
 * The whole design is that a human presses Send in Outlook. The app does not
 * request the Mail.Send scope (see MAIL_SCOPES), so even a bug or a
 * prompt-injected instruction in an incoming email cannot put a message on the
 * wire — Microsoft would reject the call. Adding a send helper here would
 * quietly remove that guarantee. Don't.
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
