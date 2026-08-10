-- Jade Agent — staff presence board
-- Tables: staff_directory, staff_presence
--
-- Today absences travel as prose: the office manager mails all staff "Please
-- note that Vidhya is sick today". Phase 1 extracts those lines into
-- staff_presence so the board can be read at a glance instead of by scrolling
-- a mailbox. Phase 2 adds in-app leave requests approved by a department
-- manager, which land in the SAME table with source='request'. The schema is
-- built for both now so phase 2 is an insert path, not a migration of history.
--
-- The two tables split along a hard line: staff_directory is what we KNOW
-- (a curated roster, edited by admins), staff_presence is what we were TOLD
-- (an extraction or a request, possibly wrong). Keeping them apart is what
-- lets an unresolved or misread name sit on the board flagged for review
-- rather than quietly inventing an employee.
--
-- staff_presence is written only by edge functions running as the service
-- role, the same shape as email_messages in 0003_email_assistant.sql.
-- staff_directory is admin-editable from the UI via supabase-js, the same
-- shape as buildings in 0001_init.sql, and reuses that file's is_admin()
-- helper rather than introducing a second notion of "admin".

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- The roster. Its primary job is not display, it is trust: a name lifted out
-- of an email is only believed if it resolves to a row here. Without that
-- gate, a typo ('Sndy') becomes a permanent phantom employee on the board and
-- nobody can tell it from a real one.
create table if not exists public.staff_directory (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  -- The first name as it actually appears in the emails ('Sandy',
  -- 'Marie-Claire'), which is rarely the first token of full_name.
  known_as text not null,
  -- Alternative spellings and nicknames, so matching does not depend on the
  -- office manager being consistent. Kept as an array on the person rather
  -- than a side table: it is read on every extraction and never queried on
  -- its own.
  aliases text[] not null default '{}',
  -- Nullable on purpose: site staff (guards, maintenance) have no mailbox but
  -- are absent as often as anyone, and refusing to roster them would push
  -- their absences back into the unresolved pile forever.
  email text,
  department text,
  -- Self-reference. Phase 2 routes a leave request to this person's manager;
  -- on delete set null so removing a manager orphans the reporting line
  -- instead of deleting their reports.
  manager_id uuid references public.staff_directory(id) on delete set null,
  is_manager boolean not null default false,
  -- Leavers are deactivated, never deleted: their past presence rows must keep
  -- resolving to a name.
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Deliberately NOT unique on known_as. Two people can genuinely share a first
-- name; the application layer detects that ambiguity and flags the record for
-- human review. A unique constraint would instead block the roster from
-- representing reality.

comment on table public.staff_directory is
  'Curated staff roster. Resolving an extracted name against this table is the '
  'only thing standing between a typo in an email and a phantom employee on '
  'the presence board. Admin-writable via RLS; see is_admin() in 0001_init.sql.';

-- One row = one person, one date, one status. Not a date range: the emails
-- announce single days, and a phase-2 multi-day leave request expands into one
-- row per day so the board never has to reason about overlaps at read time.
create table if not exists public.staff_presence (
  id uuid primary key default gen_random_uuid(),
  -- NULLABLE on purpose. When a name cannot be resolved we still record the
  -- absence and set needs_review, because the alternative — dropping it — is
  -- silent data loss that nobody ever notices. An unresolved row is visible
  -- and fixable; a discarded one is not.
  staff_id uuid references public.staff_directory(id) on delete cascade,
  -- The name exactly as written in the email, kept even after a successful
  -- resolution. This is the audit trail: without it, a wrong match ('Sandy' ->
  -- the other Sandy) is undetectable after the fact because the row would only
  -- carry the id we chose.
  raw_name text not null,
  on_date date not null,
  status text not null check (status in ('sick','local_leave','permission','late','off_site','other')),
  -- 'partial' covers "will be late" and "has already left office": the person
  -- was present for some undefined slice of the day. It is distinct from
  -- 'am'/'pm', which assert which half.
  day_part text not null default 'full' check (day_part in ('full','am','pm','partial')),
  note text,
  source text not null check (source in ('email','request','manual')),
  -- The email_messages.id (Graph message id, hence text) this was extracted
  -- from, when source='email'. Intentionally no foreign key: email_messages is
  -- per-user and prunable, and a presence record must outlive the retention of
  -- the mail it came from rather than cascade away with it.
  source_message_id text,
  needs_review boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table public.staff_presence is
  'Presence/absence board rows. RLS is on: any authenticated user may SELECT, '
  'and there are deliberately NO insert/update/delete policies — every write '
  'comes from an edge function using the service role, which bypasses RLS. '
  'This is not an oversight to be "fixed" by adding a write policy. Rows carry '
  'a claim about a colleague''s health or leave, and the extraction decides '
  'staff_id and needs_review; letting a browser session write here would let '
  'anyone assert an absence for anyone, and would bypass the resolution and '
  'review logic that makes the board trustworthy. Phase-2 leave requests must '
  'reach this table through an approval function, not through supabase-js.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- Case-insensitive resolution of an extracted first name. The roster is a few
-- dozen rows, so this is about making the lookup expression the obvious one to
-- write — lower(known_as) = lower($1) — rather than about scan cost.
create index if not exists staff_directory_known_as_lower_idx
  on public.staff_directory (lower(known_as));

-- Email is optional, so uniqueness has to be a partial index rather than a
-- column constraint: several mailbox-less staff would otherwise collide on
-- NULL under a plain unique(). Lowercased because mail addresses are matched
-- case-insensitively when reconciling a sender against the roster.
create unique index if not exists staff_directory_email_lower_key
  on public.staff_directory (lower(email))
  where email is not null;

-- Cascade target, and the phase-2 "when was this person out?" query.
create index if not exists staff_presence_staff_id_idx
  on public.staff_presence (staff_id);

-- The dominant query: the board for a date range, newest first. Leading
-- on_date desc serves both the range filter and the ordering; created_at
-- breaks ties within a day so a correction sorts above what it corrects.
create index if not exists staff_presence_on_date_idx
  on public.staff_presence (on_date desc, created_at desc);

-- Idempotency key for re-sync. The announcement EMAIL is the unit of truth:
-- one message asserting "Vidhya is sick today" must produce exactly one row no
-- matter how many times mail-sync re-reads that message, so the message id is
-- the first column. It is not enough on its own — one email routinely names
-- several people — hence raw_name, lowercased so a re-send that capitalises
-- differently is still recognised as the same assertion. on_date completes it
-- because one email can cover more than one day ("out today and tomorrow").
--
-- Note what this key deliberately does NOT collapse: the same person on the
-- same date from a different source. A correction email, and later an approved
-- leave request (source_message_id null), carry different key values and both
-- survive — which is correct, because they are different claims from different
-- authorities and the board decides which wins at read time. Squeezing them
-- into one row would destroy the reason the disagreement exists.
--
-- nulls not distinct (Postgres 15+, which Supabase is on) is what makes the
-- non-email sources dedupe at all: without it every request/manual row has a
-- null message id, all nulls are distinct, and the key silently stops applying
-- to exactly the rows a human is most likely to submit twice. The cost is that
-- two genuinely different manual entries for one person on one day collide —
-- acceptable, since that is a correction, not a second absence.
--
-- Expressed as a unique index rather than a table constraint because a
-- constraint cannot contain lower(raw_name).
create unique index if not exists staff_presence_source_dedupe_key
  on public.staff_presence (source_message_id, lower(raw_name), on_date)
  nulls not distinct;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.staff_directory enable row level security;
alter table public.staff_presence enable row level security;

-- staff_directory: any authenticated user may read — the board shows names,
-- and staff need to know who 'Sandy' is. Only admins may modify, via the
-- Settings UI, using the same is_admin() helper that guards buildings in
-- 0001_init.sql. Reusing it matters: a second, hand-rolled admin test here
-- would be a second thing to keep in sync when the role model changes.
drop policy if exists staff_directory_select on public.staff_directory;
create policy staff_directory_select on public.staff_directory
  for select
  to authenticated
  using (true);

drop policy if exists staff_directory_insert on public.staff_directory;
create policy staff_directory_insert on public.staff_directory
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists staff_directory_update on public.staff_directory;
create policy staff_directory_update on public.staff_directory
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists staff_directory_delete on public.staff_directory;
create policy staff_directory_delete on public.staff_directory
  for delete
  to authenticated
  using (public.is_admin());

-- staff_presence: read-only to every authenticated user — the board is
-- company-wide information, and an absence is already announced to all staff
-- by email today, so this stores no secret the recipients do not already hold.
-- There is no write policy at all, for any role including admins; see the
-- comment on table above for why that is deliberate.
drop policy if exists staff_presence_select on public.staff_presence;
create policy staff_presence_select on public.staff_presence
  for select
  to authenticated
  using (true);
