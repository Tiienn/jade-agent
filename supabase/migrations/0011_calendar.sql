-- Jade Agent — phase 3: in-app calendar
-- Tables: calendar_events, calendar_event_attendees, calendar_notes.
-- New helper: touch_updated_at().
--
-- Jade already has a calendar: Outlook. This one exists for exactly one reason
-- that Outlook cannot serve — it can see the presence board. Scheduling a
-- meeting here can say "three of the five people you just invited are on leave
-- that morning", because attendees are staff_directory rows and staff_presence
-- is keyed by the same ids. That single join is the justification for the
-- whole feature; every schema choice below is made to keep it cheap and exact,
-- and a future change that breaks the attendee -> staff_directory ->
-- staff_presence path removes the point of the table rather than a nicety.
--
-- Consequences of that, stated once here so they are not re-litigated per
-- table:
--   * There are no external attendees. Everyone who can be invited is a row in
--     staff_directory. An email-address attendee column would be a second,
--     unjoinable notion of "person" and the leave warning would silently stop
--     applying to whoever was recorded that way.
--   * There is no Outlook sync. No external id, no etag, no sync token, and
--     none should be added speculatively — a two-way sync is a design problem
--     (conflict resolution, deletion semantics), not a column.
--
-- Admin is is_admin() from 0001_init.sql and the session-to-roster lookup is
-- current_staff_id() from 0010_leave_requests.sql. Neither is re-implemented
-- here; a second copy of either is a second thing to keep in sync when the role
-- model or the login-to-person link changes.

-- ---------------------------------------------------------------------------
-- Shared trigger helper: updated_at
-- ---------------------------------------------------------------------------

-- Nothing like this existed before 0011 — checked across 0001-0010, which have
-- no updated_at column anywhere. Every table so far is append-only or is
-- rewritten wholesale by a server-side function (replace_presence_for_message,
-- apply_leave_decision), so "when was this last edited" had no meaning. A
-- calendar is the first thing in this schema that a user edits in place, which
-- is what makes the column worth having and the trigger worth writing.
--
-- In the database rather than in the caller, because the caller is a browser
-- and there will eventually be more than one of them: the React client today,
-- an edge function tomorrow, a psql session during an incident. A convention
-- that every writer must remember is a convention that is already broken, and
-- the failure is silent — a stale timestamp looks exactly like a row nobody
-- touched.
--
-- Unconditional overwrite: a client that helpfully sends its own updated_at has
-- it discarded, which is the point. now() is the statement timestamp, so every
-- row touched by one statement gets one timestamp.
--
-- Not security definer. This runs as whoever issued the UPDATE and needs no
-- privilege they do not already have — it only rewrites a column of the row
-- being written. Fixed search_path anyway, for the same reason is_admin() has
-- one in 0001_init.sql: so a temp-schema object cannot shadow anything it
-- resolves.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'Generic before-update trigger: stamps updated_at = now(). Shared by '
  'calendar_events and calendar_notes; attach it to any future table with an '
  'updated_at column rather than writing a second copy.';

-- ---------------------------------------------------------------------------
-- calendar_events
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_events (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  description text,

  -- timestamptz, NOT timestamp. Mauritius is UTC+4 with no DST, so today a
  -- naive wall-clock column would be right every single time — which is
  -- precisely why the mistake would go unnoticed until it was expensive.
  -- `timestamp` stores no zone, so it is not a point in time at all: it is a
  -- number that only means something if every reader assumes the same offset.
  -- The first colleague to open the app from Réunion or on a trip to Dubai, or
  -- a second office in a different zone, silently reads the wrong hour and the
  -- database cannot tell that anything went wrong. timestamptz stores the
  -- instant; the UI renders it in Mauritius time, which is a presentation
  -- decision made in one place instead of an assumption baked into every row.
  starts_at timestamptz not null,
  ends_at timestamptz not null,

  -- An all-day event still occupies an interval, and the convention is that
  -- starts_at/ends_at bound the Mauritius-local day: 00:00+04 to the next
  -- 00:00+04, end-exclusive. This is written down because the alternative
  -- reading (leave the times at whatever the client sent and just hide them)
  -- makes an all-day event ordering-unstable against timed ones and makes the
  -- date it belongs to depend on the reader's zone. all_day is therefore a
  -- RENDERING flag — do not show a time — not a licence for the timestamps to
  -- mean something different.
  all_day boolean not null default false,

  location text,

  -- WHO PUT THIS IN THE CALENDAR. on delete restrict, the same choice
  -- leave_requests.submitted_by_profile_id makes in 0010 and for the same
  -- reason: on a shared calendar the answer to "who scheduled this and why is
  -- it in my week" must survive that person leaving the company. The
  -- alternative — set null — destroys the only trace of authorship
  -- retroactively, and it does so precisely when it is most needed, on the
  -- account cleanup after someone leaves.
  --
  -- This does not block the UI. profiles.id cascades from auth.users, so a real
  -- DELETE of the login would be refused by this constraint, but admin-users
  -- does not delete: its "delete" action is an alias that sets profiles.active
  -- = false (see supabase/functions/admin-users/index.ts, which already
  -- documents this against 0010's restricts). Deactivation is the house pattern
  -- for a leaver everywhere in this schema — profiles.active,
  -- staff_directory.active, presence_announcers.active.
  created_by_profile_id uuid not null references public.profiles(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A backwards event is a typo, not a zero-length meeting. Equal is allowed on
  -- purpose: a zero-length marker at an instant is a legitimate thing to put on
  -- a calendar ("deadline 17:00").
  constraint calendar_events_time_order_check
    check (ends_at >= starts_at),

  -- An untitled block on a shared calendar tells nobody anything: it occupies
  -- everyone's grid, it makes the room or the person look busy, and there is no
  -- way to find out what it is without asking the author. btrim rather than a
  -- plain <> '' because a single space passes <> '' and renders identically to
  -- nothing at all — the constraint is about what a colleague can read, not
  -- about the byte count.
  constraint calendar_events_title_not_blank_check
    check (btrim(title) <> '')
);

comment on table public.calendar_events is
  'In-app calendar events. Unlike staff_presence (0006) and leave_requests '
  '(0010), this table IS client-writable through RLS, and that difference is '
  'deliberate rather than an oversight. Those tables carry a claim ABOUT '
  'SOMEBODY ELSE — that a colleague is sick, that leave is approved — decided '
  'by server-side logic (name resolution, needs_review, approver routing) that '
  'a browser must not be able to skip or forge. A meeting is not a claim about '
  'anyone; it is something a person schedules, owns, and may cancel. There is '
  'no server-side decision here to protect, so routing writes through an edge '
  'function would add ceremony and a deploy step without adding safety. What '
  'the policies do enforce is authorship: you may only create events as '
  'yourself, and only the author or an admin may change or delete one.';

comment on column public.calendar_events.starts_at is
  'An instant, not a wall-clock time — see the inline comment on this column '
  'in 0011_calendar.sql for why timestamp without time zone would look correct '
  'in Mauritius forever and still be wrong. For the leave warning: '
  'staff_presence.on_date is '
  'a DATE in Mauritius terms, so comparing the two means converting first — '
  '(starts_at at time zone ''Indian/Mauritius'')::date — never casting the '
  'timestamptz straight to date, which silently uses the server''s zone (UTC on '
  'Supabase) and puts every evening meeting on the wrong day.';

-- Every read of this table is a date-range window: the month grid, the week
-- view, "what is on today". Leading on starts_at serves the range scan and the
-- ordering within it.
--
-- Worth knowing rather than discovering later: an overlap query is
-- `starts_at < window_end and ends_at > window_start`, and this index only
-- constrains the first half — a long event that began before the window is
-- found by the ends_at filter, not by the index. That is fine at Jade's volume
-- (a company calendar is thousands of rows, not millions) and the fix, if it is
-- ever needed, is a range type with a GiST index, not a second btree.
create index if not exists calendar_events_starts_at_idx
  on public.calendar_events (starts_at);

drop trigger if exists calendar_events_touch_updated_at on public.calendar_events;
create trigger calendar_events_touch_updated_at
  before update on public.calendar_events
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- calendar_event_attendees
-- ---------------------------------------------------------------------------

-- The join table that makes the leave warning possible. staff_id references
-- staff_directory, not profiles, for the same reason leave_requests does: most
-- of the company has no login, and a calendar that can only invite the three
-- people with accounts is not a company calendar. It also means the warning
-- lookup is a direct staff_id match against staff_presence with no translation
-- layer in between.
create table if not exists public.calendar_event_attendees (
  event_id uuid not null references public.calendar_events(id) on delete cascade,

  -- on delete cascade — and this is a DIFFERENT judgement from
  -- staff_presence.staff_id in 0006, which deliberately keeps rows alive with a
  -- null staff_id so an unresolved absence is never silently dropped.
  --
  -- The two losses are not comparable. A presence row is a record that somebody
  -- WAS ABSENT on a date; destroying it destroys attendance history that nobody
  -- can reconstruct. An attendee row records that somebody was INVITED to a
  -- meeting, most of which are in the past and already happened. Losing "who
  -- was on the invite list for a meeting last March" when a person is deleted
  -- from the roster is an acceptable price for not accumulating dangling
  -- invitations that render as blanks in every attendee list forever.
  --
  -- It is also a cascade that in practice almost never fires: the roster UI
  -- already refuses to delete anyone who has presence history, and leavers are
  -- deactivated (staff_directory.active) rather than deleted. Deactivated
  -- people keep their invitations — active is a filter for the invite picker,
  -- not a delete.
  staff_id uuid not null references public.staff_directory(id) on delete cascade,

  -- 'pending' is the default because an invitation is not an agreement. The
  -- vocabulary stops at three: 'tentative' was left out because nothing in the
  -- app would treat it differently from 'pending', and a status the UI cannot
  -- act on is a status that only makes the list harder to read.
  response text not null default 'pending'
    check (response in ('pending','accepted','declined')),

  -- One person is on an event once. A composite PK rather than a surrogate id
  -- because there is no such thing as a second, distinguishable invitation of
  -- the same person to the same meeting, and a surrogate key would let one
  -- exist.
  primary key (event_id, staff_id)
);

comment on table public.calendar_event_attendees is
  'Who is invited to a calendar event, and their response. The whole reason '
  'this app has a calendar instead of using Outlook lives here: staff_id is a '
  'staff_directory id, the same id staff_presence is keyed by, so warning that '
  'an invitee is on leave is a join and not an integration. Rows are '
  'client-writable by the event owner; an invitee may change their own '
  'response and nothing else, which is enforced by a column-level UPDATE grant '
  'as well as by RLS — see below.';

-- "What am I invited to" is a primary query — it drives every user's own
-- calendar view — and it reads by staff_id, which the composite PK cannot
-- serve because staff_id is its trailing column. The FK cascade needs this
-- index too: without it, deleting a roster row sequentially scans this table.
create index if not exists calendar_event_attendees_staff_id_idx
  on public.calendar_event_attendees (staff_id);

-- No index on event_id: it leads the primary key, so "who is coming to this
-- meeting" and the event_id cascade are both already served.

-- ---------------------------------------------------------------------------
-- calendar_notes
-- ---------------------------------------------------------------------------

create table if not exists public.calendar_notes (
  id uuid primary key default gen_random_uuid(),

  -- A DATE, not a timestamptz, and the difference from calendar_events is the
  -- whole character of the table. An event happens AT an instant — 14:30, for
  -- forty minutes, and two of them at 14:30 conflict. A note is pinned to a
  -- day: "chase the Raffles Tower quote on Tuesday", "Marie is presenting
  -- Thursday". It has no time, no duration, and cannot conflict with anything.
  --
  -- Giving it a timestamptz anyway would force every writer to invent an hour
  -- it does not have — midnight, or whenever the user happened to type it —
  -- and then the note starts drifting across day boundaries under zone
  -- conversion for no reason, since the one thing it actually asserts is which
  -- day it belongs to. A date says exactly what is known and nothing more, and
  -- it lines up directly with staff_presence.on_date, which is a date for the
  -- same reason.
  on_date date not null,

  -- btrim, not <> '': a note made of spaces is an empty row that still takes up
  -- a line in everyone's day.
  body text not null check (btrim(body) <> ''),

  -- Only the author sees it. FALSE — shared — is the default on purpose, and
  -- the choice is worth recording because the opposite is the more common
  -- instinct and would look like the safer one. This is a company planning
  -- calendar: the value of a note is that a colleague reads it before walking
  -- into the same week unprepared. Defaulting to private means the common case
  -- requires an extra deliberate click, most people will not make it, and the
  -- shared surface quietly becomes a collection of private diaries that happen
  -- to share a grid. Nobody would report that as a bug; it would just never
  -- work. Anything genuinely sensitive is a deliberate act, which is what the
  -- flag is for.
  is_private boolean not null default false,

  -- on delete restrict for the same reason as calendar_events: an anonymous
  -- note on a shared day is unactionable — the first question about any note is
  -- who wrote it. See that column's comment for why this does not block the
  -- admin-users flow.
  created_by_profile_id uuid not null references public.profiles(id) on delete restrict,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.calendar_notes is
  'Dated notes on the calendar — "what I need to remember about Tuesday", not '
  'something that happens at 14:30, hence a DATE rather than a timestamptz. '
  'Client-writable for the same reason as calendar_events. is_private hides a '
  'note from colleagues, NOT from admins: the SELECT policy lets is_admin() '
  'read every note, deliberately, because an admin can already read the row in '
  'the dashboard and pretending otherwise in the policy would only mislead the '
  'next reader of this file. It is "not shown to the team", not a secret.';

create index if not exists calendar_notes_on_date_idx
  on public.calendar_notes (on_date);

drop trigger if exists calendar_notes_touch_updated_at on public.calendar_notes;
create trigger calendar_notes_touch_updated_at
  before update on public.calendar_notes
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.calendar_events enable row level security;
alter table public.calendar_event_attendees enable row level security;
alter table public.calendar_notes enable row level security;

-- --- calendar_events -------------------------------------------------------

-- Read: everyone. A shared calendar whose entries are selectively invisible is
-- not a shared calendar — the point is that a colleague can see the week before
-- booking over it. Note the asymmetry with leave_requests (0010), which is
-- narrowly readable: a leave request carries a reason field that is routinely
-- medical or domestic, whereas an event is a thing already visible to everyone
-- it involves.
drop policy if exists calendar_events_select on public.calendar_events;
create policy calendar_events_select on public.calendar_events
  for select
  to authenticated
  using (true);

-- Insert: anyone, but only as themselves.
--
-- The spec for this table said "any authenticated user may INSERT", and pinning
-- created_by_profile_id to auth.uid() is a deliberate tightening rather than
-- an extra. Without the check, a client can insert an event attributed to a
-- colleague — which forges the one fact the on delete restrict above exists to
-- preserve, and hands editing rights to somebody who did not create it while
-- taking them away from whoever did.
--
-- No is_admin() escape hatch here, unlike the UPDATE policy. An admin creating
-- an event in someone else's name is on-behalf-of filing, and 0010 shows what
-- that requires to be honest: a SEPARATE submitted_by column, so "who it is
-- for" and "who typed it in" stay distinguishable. This table has one such
-- column, so letting an admin write an arbitrary value into it would make a
-- filed-for-you event indistinguishable from one the person created
-- themselves. If on-behalf-of scheduling is ever wanted, add the second column
-- rather than relaxing this check.
drop policy if exists calendar_events_insert on public.calendar_events;
create policy calendar_events_insert on public.calendar_events
  for insert
  to authenticated
  with check (created_by_profile_id = auth.uid());

-- Update/delete: the author, or an admin. Admins are in it for the reason they
-- are in every policy in this schema — somebody has to be able to clear a
-- recurring block left behind by a person who has left, and the alternative is
-- a support request that ends in psql.
--
-- with check mirrors using, so an author cannot hand their event to somebody
-- else in the act of editing it. An admin can reassign created_by_profile_id,
-- which follows from is_admin() being true on both sides and is accepted: an
-- admin correcting authorship is a legitimate repair, and an admin willing to
-- forge it can do so through the dashboard regardless.
drop policy if exists calendar_events_update on public.calendar_events;
create policy calendar_events_update on public.calendar_events
  for update
  to authenticated
  using (created_by_profile_id = auth.uid() or public.is_admin())
  with check (created_by_profile_id = auth.uid() or public.is_admin());

drop policy if exists calendar_events_delete on public.calendar_events;
create policy calendar_events_delete on public.calendar_events
  for delete
  to authenticated
  using (created_by_profile_id = auth.uid() or public.is_admin());

-- --- calendar_event_attendees ----------------------------------------------

-- Read: everyone, matching the events themselves. Knowing who else is invited
-- is most of the value of seeing the event at all.
drop policy if exists calendar_event_attendees_select on public.calendar_event_attendees;
create policy calendar_event_attendees_select on public.calendar_event_attendees
  for select
  to authenticated
  using (true);

-- The guest list belongs to whoever owns the meeting. Ownership is read from
-- the parent event rather than duplicated here, so it cannot drift: an admin
-- reassigning an event moves its guest list with it automatically.
--
-- Deliberately NOT extended to "or the row is my own", which would let anyone
-- add themselves to any meeting in the company. Self-invitation is not what the
-- invitee needs — accepting or declining is an UPDATE of a row that already
-- exists, and that is covered separately below.
drop policy if exists calendar_event_attendees_insert on public.calendar_event_attendees;
create policy calendar_event_attendees_insert on public.calendar_event_attendees
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.calendar_events e
      where e.id = calendar_event_attendees.event_id
        and (e.created_by_profile_id = auth.uid() or public.is_admin())
    )
  );

-- Two permissive UPDATE policies, OR'd by Postgres: the owner may update any
-- attendee row of their event, and an invitee may update their OWN row.
--
-- The second one is the "accept / decline" path, and on its own it would grant
-- more than accepting and declining. RLS is row-level: a policy cannot say
-- "only the response column", and it cannot compare NEW against OLD, so a
-- self-update permitted this way could also rewrite event_id — moving one's
-- attendance to a different meeting, which is self-invitation and
-- self-removal in a single statement, exactly the two things the policy was
-- written to withhold. (staff_id is pinned by the with check; event_id is not,
-- and cannot be.)
--
-- So the column restriction is expressed with the mechanism that actually has
-- column granularity — a GRANT — immediately after these policies. The two
-- work together and neither is sufficient alone: the grant says which columns
-- anyone may write, the policies say which rows.
--
-- current_staff_id() (0010) returns NULL for a login with no roster row, and
-- NULL = x is NULL, so an unlinked session matches no row here rather than
-- every row.
drop policy if exists calendar_event_attendees_update_owner on public.calendar_event_attendees;
create policy calendar_event_attendees_update_owner on public.calendar_event_attendees
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.calendar_events e
      where e.id = calendar_event_attendees.event_id
        and (e.created_by_profile_id = auth.uid() or public.is_admin())
    )
  )
  with check (
    exists (
      select 1
      from public.calendar_events e
      where e.id = calendar_event_attendees.event_id
        and (e.created_by_profile_id = auth.uid() or public.is_admin())
    )
  );

drop policy if exists calendar_event_attendees_update_self on public.calendar_event_attendees;
create policy calendar_event_attendees_update_self on public.calendar_event_attendees
  for update
  to authenticated
  using (staff_id = public.current_staff_id())
  with check (staff_id = public.current_staff_id());

-- Delete: the event owner only. An invitee declining sets response =
-- 'declined'; they do not remove themselves, and that is the better outcome
-- rather than a limitation to work around. A declined row tells the organiser
-- something ("Rekha can't make it"); a vanished row tells them nothing and
-- looks identical to never having invited the person, so the organiser
-- re-invites and the loop repeats.
drop policy if exists calendar_event_attendees_delete on public.calendar_event_attendees;
create policy calendar_event_attendees_delete on public.calendar_event_attendees
  for delete
  to authenticated
  using (
    exists (
      select 1
      from public.calendar_events e
      where e.id = calendar_event_attendees.event_id
        and (e.created_by_profile_id = auth.uid() or public.is_admin())
    )
  );

-- Column-level UPDATE privilege: response, and nothing else.
--
-- This is the half of the attendee rules that RLS structurally cannot express,
-- and it is what makes the self-update policy above safe: with it in place, the
-- only column an authenticated session can write on an existing attendee row is
-- response, so re-pointing event_id is refused by the privilege check before
-- any policy is consulted. It applies to the event owner too, which costs
-- nothing — changing WHO is invited is an insert and a delete, never an update
-- of an existing row's identity columns.
--
-- Supabase's default privileges grant ALL on new tables in public to
-- authenticated, so the revoke is not optional; without it the grant below adds
-- nothing. service_role is untouched and keeps full rights, as everywhere else
-- in this schema. anon is left alone deliberately: no policy on this table
-- names anon, so RLS already denies it everything, and revoking privileges it
-- cannot exercise would only suggest the privileges were the protection.
--
-- Footgun worth stating: a column added to this table later will NOT be
-- writable by authenticated, because column grants do not extend to new
-- columns. That default is the safe direction, but the failure looks like a
-- mysterious "permission denied for table calendar_event_attendees" from
-- PostgREST rather than anything mentioning the column — so a future ALTER
-- TABLE here needs a matching GRANT.
revoke update on public.calendar_event_attendees from authenticated;
grant update (response) on public.calendar_event_attendees to authenticated;

-- --- calendar_notes --------------------------------------------------------

-- Read: shared notes to everyone, private notes to their author, everything to
-- admins. See the table comment for why admin visibility is stated rather than
-- quietly true.
drop policy if exists calendar_notes_select on public.calendar_notes;
create policy calendar_notes_select on public.calendar_notes
  for select
  to authenticated
  using (
    is_private = false
    or created_by_profile_id = auth.uid()
    or public.is_admin()
  );

-- Insert: as yourself only. Same reasoning as calendar_events_insert — writing
-- a note into a colleague's name on a shared calendar is impersonation, and
-- with is_private available it would also be a way to plant something only they
-- can see.
drop policy if exists calendar_notes_insert on public.calendar_notes;
create policy calendar_notes_insert on public.calendar_notes
  for insert
  to authenticated
  with check (created_by_profile_id = auth.uid());

-- Update/delete: author or admin, with check mirroring using so authorship
-- cannot be reassigned by a non-admin mid-edit.
--
-- Note what an author retains: flipping is_private on an existing note in
-- either direction. Making a shared note private does not unsay it — colleagues
-- may have read it already — and that is fine; the flag governs display, not
-- history, and this schema keeps no note revisions to reveal.
drop policy if exists calendar_notes_update on public.calendar_notes;
create policy calendar_notes_update on public.calendar_notes
  for update
  to authenticated
  using (created_by_profile_id = auth.uid() or public.is_admin())
  with check (created_by_profile_id = auth.uid() or public.is_admin());

drop policy if exists calendar_notes_delete on public.calendar_notes;
create policy calendar_notes_delete on public.calendar_notes
  for delete
  to authenticated
  using (created_by_profile_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- The leave warning
-- ---------------------------------------------------------------------------

-- No new object is needed for it, which is the intended outcome — the warning
-- is a query over tables that already exist, not a feature with its own
-- storage. Recorded here so the next reader does not go looking for the piece
-- that implements it:
--
--   select a.staff_id, p.on_date, p.status, p.day_part
--     from calendar_events e
--     join calendar_event_attendees a on a.event_id = e.id
--     join staff_presence p on p.staff_id = a.staff_id
--    where e.id = $1
--      and p.on_date between (e.starts_at at time zone 'Indian/Mauritius')::date
--                        and (e.ends_at   at time zone 'Indian/Mauritius')::date;
--
-- Both sides are indexed already — calendar_event_attendees_staff_id_idx above,
-- staff_presence_staff_id_idx and staff_presence_on_date_idx from 0006 — so
-- this stays a lookup at any plausible size.
--
-- Two things it must keep doing, both of which are easy to lose in a rewrite:
--   * Convert the instant to a Mauritius date, as above. A bare
--     starts_at::date uses the session zone, which on Supabase is UTC, and puts
--     any event after 20:00 local on the following day.
--   * WARN, never block. staff_presence holds what we were TOLD (0006), and a
--     misparsed email is a routine occurrence the board flags for review — it
--     must never be able to prevent a meeting from being scheduled. A multi-day
--     event spans several dates, so the warning is a range check, and a person
--     with no presence row is simply not flagged rather than presumed present.
