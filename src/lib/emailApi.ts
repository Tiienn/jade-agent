// Typed client for the mail-* edge functions.
//
// The table reads (email_messages, email_drafts, email_rules) go through
// supabase-js directly — RLS already scopes them to the signed-in user. Only
// the four calls below need the server: they touch Microsoft Graph or the
// deliberately client-unreadable mail_accounts table.
//
// Transport helpers are shared with api.ts rather than re-declared, so there is
// one definition of how a Jade request is authorised and how a backend error
// message reaches the UI.

import {
  ApiError,
  FUNCTIONS_BASE,
  authHeaders,
  parseJsonError,
} from './api'

/** Mailbox connection state for the signed-in user. Never includes a token. */
export interface MailStatus {
  connected: boolean
  email: string | null
  lastSyncAt: string | null
  /** Set when the last sync failed — usually a revoked/expired mailbox grant. */
  lastSyncError: string | null
}

/** What a sync run did, by triage bucket. */
export interface SyncCounts {
  synced: number
  action: number
  fyi: number
  ignored: number
}

/** Register the drafting model chose for a reply. */
export type DraftRegister = 'internal' | 'vendor' | 'formal'

export interface DraftResult {
  body: string
  register: DraftRegister
  /** Id of the real draft written into the user's Outlook Drafts folder. */
  outlookDraftId: string
}

export type TriageVerdict = 'action' | 'fyi' | 'ignore'

/** A row of `email_messages`. Envelope only — bodies are never stored. */
export interface EmailMessage {
  id: string
  user_id: string
  conversation_id: string | null
  from_email: string | null
  from_name: string | null
  subject: string | null
  received_at: string | null
  to_me: boolean
  triage: TriageVerdict
  triage_reason: string | null
  /** Opens the message in Outlook Web. */
  web_link: string | null
}

/** A row of `email_drafts`. */
export interface EmailDraft {
  message_id: string
  user_id: string
  body: string
  register: DraftRegister | null
  outlook_draft_id: string | null
  created_at: string
}

/** A row of `email_rules` — a full address or a bare domain. */
export interface EmailRule {
  id: string
  user_id: string
  pattern: string
  action: 'ignore' | 'prioritise'
  created_at: string
}

/** POST a JSON body to a mail-* function and parse the JSON reply. */
async function postMail<T>(
  fn: string,
  body: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  const res = await fetch(`${FUNCTIONS_BASE}/${fn}`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    await parseJsonError(res, fallback)
  }
  return (await res.json()) as T
}

/** Whether a mailbox is linked, and how the last sync went. */
export function mailStatus(): Promise<MailStatus> {
  return postMail<MailStatus>(
    'mail-status',
    {},
    'Could not check your mailbox connection.',
  )
}

/** Start the Microsoft consent flow. Send the browser to the returned authUrl. */
export function mailConnect(): Promise<{ authUrl: string }> {
  return postMail<{ authUrl: string }>(
    'mail-connect',
    {},
    'Could not start the mailbox connection.',
  )
}

/**
 * Pull and triage new mail. Omit `sinceHours` for the normal incremental sync;
 * pass 1–168 to re-scan a window that has already been synced.
 *
 * Throws `ApiError` with `code === 'mailbox_not_connected'` when no mailbox is
 * linked — callers should send the user back to the connect screen.
 */
export function mailSync(sinceHours?: number): Promise<SyncCounts> {
  const body = sinceHours === undefined ? {} : { sinceHours }
  return postMail<SyncCounts>('mail-sync', body, 'Could not sync your mailbox.')
}

/**
 * Write a reply draft for one message, in the user's style, straight into their
 * Outlook Drafts folder. Slow — an LLM call, typically 10–30s.
 */
export function mailDraft(messageId: string): Promise<DraftResult> {
  return postMail<DraftResult>(
    'mail-draft',
    { messageId },
    'Could not write a draft for this message.',
  )
}

export { ApiError }
