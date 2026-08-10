-- What staff_presence.source_message_id actually holds.
--
-- DOCUMENTATION ONLY. No table, index or row is altered — the dedupe index in
-- 0006 was already correct; what was wrong was the VALUE being written into it,
-- and that is a code change (mail-sync, presence-backfill, presenceStore).
-- This migration exists so the column's meaning is recorded next to the schema
-- rather than only in a function nobody reads while debugging a duplicate row.
--
-- The bug this prevents:
--   Absence notices go to an all-staff distribution list, so one announcement
--   lands in many mailboxes. A Microsoft Graph message id identifies A COPY of
--   a message in ONE mailbox — the same email carries a different Graph id for
--   every recipient. /email is gated by ProtectedRoute, not by admin, so any
--   member of staff can connect their own mailbox, and the scheduled sync
--   sweeps every connected account. Keyed on the Graph id, one notice saying
--   "Vidhya is sick today" would therefore be filed once per colleague using
--   the app: same person, same date, different key, no collision, and a board
--   quietly showing Vidhya absent three times.
--
--   The RFC 5322 Message-ID is stamped once by the sending server and travels
--   with every copy. Keyed on that, the recipients collapse into one row by
--   themselves through the existing unique index.
--
-- Deliberately NOT unified with email_messages.id, which remains the Graph id.
-- These are different identifiers answering different questions, and that is
-- correct rather than an inconsistency to tidy up:
--   * email_messages is per-user and models A MAILBOX'S COPY — two people who
--     receive the same mail each have their own row, their own read state and
--     their own triage verdict. The copy is the thing.
--   * staff_presence models THE ANNOUNCEMENT — the fact asserted, independent
--     of how many mailboxes happen to hold it. The message is the thing.
-- Anyone tempted to make them match should change neither.
--
-- Fallback: a malformed message can carry no Message-ID. The write path then
-- falls back to the Graph id and sets needs_review on those rows, because
-- losing a sick colleague off the board is worse than a possible duplicate —
-- and a flagged duplicate is visible, which a silent one is not.

comment on column public.staff_presence.source_message_id is
  'RFC 5322 Message-ID (Graph internetMessageId) of the announcement email this '
  'row was extracted from — NOT the Graph message id. The Graph id identifies '
  'one mailbox''s copy, so an all-staff notice carries a different one per '
  'recipient; keying on it duplicates every absence once a second colleague '
  'connects a mailbox. The Message-ID is identical in every copy, so the unique '
  'index (source_message_id, lower(raw_name), on_date) collapses them. NULL for '
  'source=''request''/''manual''. Falls back to the Graph id, with '
  'needs_review set, only when a message carries no Message-ID at all. '
  'email_messages.id is still the Graph id and is intentionally different: that '
  'table models a mailbox''s copy, this one models the announcement.';
