-- staff_presence.status gains 'vacation_leave'.
--
-- WHY THIS IS NOT local_leave:
--
--   In Mauritius these are two different entitlements, not two words for the
--   same thing. Local leave is the short casual day taken at short notice —
--   "Rekha is on local leave today". Vacation leave is the planned annual one,
--   and it is measured in weeks: the notice that prompted this migration reads
--   "Marie-Claire is on 3 weeks' vacation leave effective as from today".
--
--   Folding the second into the first would be a lossy rename with real
--   consequences at the only place this data is ever used. The board answers
--   one question — "is this person around?" — and the honest answer for a
--   three-week absence ("back next month") is not the same answer as for a
--   casual day ("back tomorrow"). Collapsed into local_leave, twenty-one rows
--   of annual leave are indistinguishable from twenty-one people each taking a
--   day off, and nobody reading the board can tell that the person they are
--   waiting on is on a beach in Rodrigues. The status column is the only place
--   that distinction can live: note is free text nothing queries, and the
--   date range says how long the absence is but not what kind it is.
--
--   The parser makes the same split for the same reason — see PresenceStatus in
--   supabase/functions/_shared/presence.ts, whose clause vocabulary now maps
--   "is on vacation leave" and "is on N weeks' vacation leave" to this value.
--   That is what makes this migration load-bearing rather than cosmetic: the
--   CHECK below is the gate every extracted row passes through, so until it
--   admits 'vacation_leave' the insert in replace_presence_for_message (0007)
--   raises and the WHOLE announcement is lost, not just the vacation row.
--
-- Drop-and-recreate rather than a new constraint alongside the old one: two
-- CHECKs on one column would both have to pass, so leaving 0006's in place
-- would keep rejecting exactly the value this migration exists to allow. The
-- constraint is recreated under the name Postgres gave the inline CHECK in
-- 0006 (staff_presence_status_check), so this file stays idempotent and a
-- future widening has one obvious name to target rather than an accumulating
-- pile of hand-named constraints.
--
-- NO DATA MIGRATION IS NEEDED, and none is wanted. The five clauses this
-- vocabulary was built from were not lost while they were unparseable — they
-- were recorded as status 'other' with the sentence in note and needs_review
-- set, which is the designed fallback. Those rows correct themselves on the
-- next backfill without being touched here: replace_presence_for_message
-- deletes every row for a source_message_id before inserting the new reading,
-- so re-running presence-backfill over the same mail replaces the 'other' rows
-- with 'vacation_leave' ones in the same statement. Rewriting them here would
-- mean guessing from free text which 'other' rows were vacation notices, in
-- SQL, without the parser — strictly worse than re-reading the original email.

alter table public.staff_presence
  drop constraint if exists staff_presence_status_check;

alter table public.staff_presence
  add constraint staff_presence_status_check
  check (status in (
    'sick',
    'local_leave',
    -- Annual leave. Distinct from local_leave on purpose; see above.
    'vacation_leave',
    'permission',
    'late',
    'off_site',
    -- The fallback. An absence whose wording the parser did not recognise is
    -- still recorded, flagged for review, with the sentence in note. Silence
    -- would be indistinguishable from a fully staffed office.
    'other'
  ));

comment on column public.staff_presence.status is
  'What kind of absence this is. ''local_leave'' is short casual leave (a day '
  'or two, at short notice); ''vacation_leave'' is planned annual leave, '
  'usually weeks — the two are separate entitlements in Mauritius and '
  'collapsing them would report a three-week holiday as a day off. '
  '''permission'' covers stepping out of the office for part of a day, '
  '''off_site'' is working away rather than absent, and ''other'' is the '
  'fallback for wording the extractor did not recognise: those rows carry the '
  'original sentence in note and needs_review = true, and are re-read (not '
  'patched in SQL) whenever the parser learns the phrasing. Any new value here '
  'needs a migration widening staff_presence_status_check AND a matching '
  'change to PresenceStatus in supabase/functions/_shared/presence.ts.';
