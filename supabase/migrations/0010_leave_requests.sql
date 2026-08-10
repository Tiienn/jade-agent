-- Jade Agent — phase 2: in-app leave requests
-- Tables: leave_requests. Altered: staff_directory, staff_presence.
--
-- 0006 built staff_presence for two writers and only shipped one: absences
-- extracted from all-staff mail (source='email'). This is the second writer.
-- A member of staff files a request, a department manager approves it, and the
-- approved days land in the SAME staff_presence table with source='request',
-- so the board keeps answering one question from one place regardless of how
-- the absence was announced.
--
-- The split 0006 drew still holds and this file does not blur it:
-- staff_directory is what we KNOW, staff_presence is what we were TOLD, and
-- leave_requests is a third thing — what somebody ASKED FOR, including the
-- asks that were declined and therefore never become presence at all. Keeping
-- the request separate from its consequence is what makes a decision
-- reversible: the request row is the durable record, the presence rows are
-- derived from it and can be thrown away and rebuilt.
--
-- Every write to leave_requests goes through an edge function using the
-- service role, the same shape as staff_presence in 0006 and email_messages in
-- 0003_email_assistant.sql. Admin is is_admin() from 0001_init.sql throughout;
-- there is no second notion of admin in this file.

-- ---------------------------------------------------------------------------
-- Linking a login to a roster person
-- ---------------------------------------------------------------------------

-- staff_directory and profiles have been unrelated tables until now, and could
-- afford to be: everything phase 1 does is driven by an email address, not by
-- who is signed in. Routing a request to "this person's manager" cannot be —
-- it has to turn the current session into a roster row before it can follow
-- manager_id.
--
-- Nullable, and expected to STAY null for most rows. There are three logins
-- today against eighteen people named in the mail, and site staff and guards
-- will never have one; a NOT NULL here would make the roster unable to hold
-- most of the company, which is precisely the population whose absences the
-- board exists to show.
--
-- Unique because a login is one person. Without it two roster rows could claim
-- the same session and current_staff_id() below would return whichever the
-- planner felt like — a request silently filed as, or routed to, the wrong
-- colleague.
--
-- on delete set null, not cascade: an account is a way of signing in, not the
-- person. Deleting Charles's login must not delete Charles from the roster and
-- take his attendance history with him.
alter table public.staff_directory
  add column if not exists profile_id uuid unique references public.profiles(id) on delete set null;

comment on column public.staff_directory.profile_id is
  'The login this roster person signs in with, or NULL — most staff have no '
  'account and are not expected to get one. Unique: one login is one person. '
  'Deleting the account nulls this and leaves the person and their presence '
  'history intact. Written by admins through the existing staff_directory '
  'write policies from 0006; no new policy is needed for this column.';

-- The session-to-roster lookup, mirroring is_admin() in 0001_init.sql.
--
-- security definer + stable + fixed search_path for the same three reasons
-- is_admin() has them: definer so a policy calling it cannot recurse back into
-- the RLS of the table it reads, stable so the planner may call it once per
-- statement instead of once per row, and a pinned search_path so a temp schema
-- object cannot shadow staff_directory and answer the question for us.
--
-- Returns NULL for a signed-in user with no roster link, which is the common
-- case and must stay harmless: every policy below compares against it with =,
-- and NULL = anything is NULL, so an unlinked session matches no row rather
-- than matching all of them.
--
-- 'and active' so a deactivated person keeps their history but stops being a
-- live actor. limit 1 is redundant against the unique constraint above and
-- kept anyway, so this cannot start returning "more than one row" if that
-- constraint is ever relaxed.
create or replace function public.current_staff_id()
returns uuid
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select id
  from public.staff_directory
  where profile_id = auth.uid()
    and active
  limit 1
$$;

comment on function public.current_staff_id() is
  'The staff_directory row of the signed-in user, or NULL if their login is '
  'not linked to one. Deliberately callable by authenticated, unlike '
  'apply_leave_decision below: RLS policies on leave_requests invoke it as the '
  'calling user, so revoking execute would deny every user their own requests. '
  'It leaks nothing — it can only ever return the caller''s own id.';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.leave_requests (
  id uuid primary key default gen_random_uuid(),

  -- WHO THE LEAVE IS FOR. A roster row, not a login, because most staff have
  -- no login: an admin or the office manager files on behalf of a guard who
  -- will never open the app, and that request is exactly as real as one typed
  -- by the person themselves.
  requester_staff_id uuid not null references public.staff_directory(id) on delete cascade,

  -- WHO TYPED IT IN. Separate from the above, and both are kept, because they
  -- answer different questions that a leave record is eventually asked: "was
  -- Rekha off on the 12th?" and "who says so?". Collapsing them would make an
  -- on-behalf-of filing indistinguishable from a self-service one, which is
  -- the difference between a record and a claim the moment anybody disputes it.
  --
  -- on delete restrict: deleting an account that has filed leave requests is
  -- blocked on purpose — the alternative is nulling the only trace of who
  -- submitted them, i.e. destroying the audit trail retroactively. The house
  -- pattern for a leaver is deactivation, not deletion (profiles.active,
  -- staff_directory.active, presence_announcers.active all exist for this).
  submitted_by_profile_id uuid not null references public.profiles(id) on delete restrict,

  -- The same vocabulary as staff_presence.status, narrowed to the kinds a
  -- person can actually request. 'late', 'off_site' and 'other' are omitted
  -- deliberately: they are things that get REPORTED after the fact by the
  -- office manager, not asked for in advance, and offering them here would
  -- invite requests nobody has the authority to approve.
  --
  -- 'vacation_leave' is separate from 'local_leave' for the reason spelled out
  -- in 0009: in Mauritius they are different entitlements, and a three-week
  -- annual leave is not a long casual day.
  leave_type text not null check (leave_type in ('sick','local_leave','vacation_leave','permission')),

  -- A range, unlike staff_presence, which is one row per day. The request is
  -- what a human said ("the 12th to the 16th"); the expansion into days is a
  -- consequence of approving it. Storing the range here keeps the edit surface
  -- one row instead of five, and keeps the board free of overlap arithmetic at
  -- read time — see the note on staff_presence in 0006.
  start_date date not null,
  end_date date not null,

  -- No 'partial' here, though staff_presence allows it: 'partial' means "gone
  -- for some undefined slice of the day", which is something observed after
  -- the fact, never something requested.
  day_part text not null default 'full' check (day_part in ('full','am','pm')),

  reason text,

  status text not null default 'pending' check (status in ('pending','approved','declined','cancelled')),

  -- The manager this was routed to, resolved server-side from the requester's
  -- manager_id at submission time and frozen here. Frozen rather than followed
  -- live because a reorganisation must not retroactively change who approved
  -- last quarter's leave. on delete set null so removing a manager from the
  -- roster orphans the routing instead of deleting their reports' requests —
  -- the same choice staff_directory.manager_id makes in 0006.
  approver_staff_id uuid references public.staff_directory(id) on delete set null,

  -- Null until decided; that is what makes 'pending' checkable against
  -- reality rather than just a string. on delete restrict for the same reason
  -- as submitted_by_profile_id: "who approved this" is not a fact worth losing
  -- to an account cleanup.
  decided_by_profile_id uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_note text,

  created_at timestamptz not null default now(),

  -- A backwards range is not a short leave, it is a typo, and it expands into
  -- zero presence rows — an approved absence that never appears on the board
  -- and that nobody can explain the absence of.
  constraint leave_requests_date_order_check
    check (end_date >= start_date),

  -- A half day is by definition one day. "AM only, 12th to the 16th" has no
  -- meaning anyone could act on: it is neither five mornings nor one, and
  -- whichever the expansion picked would be a guess presented as a decision.
  constraint leave_requests_day_part_span_check
    check (day_part = 'full' or start_date = end_date)
);

comment on table public.leave_requests is
  'In-app leave requests. RLS is on and there are deliberately NO '
  'insert/update/delete policies, for any role including admins — every '
  'mutation goes through an edge function using the service role. This is not '
  'an oversight to be "fixed" by adding a write policy. The approver is '
  'resolved server-side from the roster: a client that could INSERT would name '
  'itself as its own approver, and a client that could UPDATE would set its '
  'own request to approved and write itself onto the presence board. The read '
  'policy is the whole of what a browser is trusted with here. Approved rows '
  'reach staff_presence only through apply_leave_decision().';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The manager's queue, and the only query with a latency budget that matters:
-- it runs on every page load for anyone who manages anybody. Partial on
-- status='pending' because decided requests are the overwhelming majority
-- within weeks and none of them belong in a queue; created_at orders the
-- backlog oldest-first, since the point of a queue is that the thing waiting
-- longest is the thing to do next.
create index if not exists leave_requests_approver_pending_idx
  on public.leave_requests (approver_staff_id, created_at)
  where status = 'pending';

-- "My leave", newest first — the requester's own history page, and the lookup
-- that answers "have I already asked for this?" before a duplicate is filed.
create index if not exists leave_requests_requester_idx
  on public.leave_requests (requester_staff_id, created_at desc);

-- ---------------------------------------------------------------------------
-- staff_presence gains a second provenance column
-- ---------------------------------------------------------------------------

-- source_message_id (0006, clarified in 0008) says which email a row came
-- from. This says which request. Exactly one of the two is set on any row:
-- 'email' rows have a message id, 'request' rows have a request id, 'manual'
-- rows have neither.
--
-- on delete cascade, unlike source_message_id which has no foreign key at all.
-- The reasoning is opposite in the two cases and both are deliberate: a
-- presence row must OUTLIVE the mail it was extracted from, because mailboxes
-- are pruned and the absence still happened; but it must NOT outlive the
-- request it was derived from, because a withdrawn or deleted request is a
-- statement that the absence was never agreed. Without the cascade, cancelling
-- leave leaves the days sitting on the board forever, pointing at nothing,
-- with no UI anywhere that can remove them.
alter table public.staff_presence
  add column if not exists source_request_id uuid references public.leave_requests(id) on delete cascade;

comment on column public.staff_presence.source_request_id is
  'The leave_requests row this presence day was derived from, for '
  'source=''request'' rows; NULL for ''email'' and ''manual''. Cascades on '
  'delete: the board must not outlive the approval that justified it. Written '
  'only by apply_leave_decision(), which owns the whole lifecycle of these '
  'rows — delete then re-insert, never patch.';

-- Extend the dedupe key rather than leave it alone.
--
-- 0006's key is (source_message_id, lower(raw_name), on_date) with nulls not
-- distinct, and its reasoning is unchanged and still load-bearing: one
-- announcement email must produce exactly one row however many times mail-sync
-- re-reads it, raw_name is lowercased so a re-send that capitalises
-- differently is still the same assertion, on_date is there because one email
-- can cover several days, and nulls not distinct is what makes the key apply
-- at all to sources that have no message id. None of that changes here.
--
-- What changes is that phase 2 turns "no message id" from a rare manual entry
-- into the normal case. Every request row carries source_message_id = NULL, so
-- under nulls not distinct the key for all of them collapses to
-- (NULL, name, date) — and two different approved requests for the same person
-- on the same date would silently deduplicate into one row.
--
-- That sounds correct for about five seconds. It is not:
--   * A morning request and an afternoon request are two legitimate rows for
--     one person on one day. 0006 already accepted this collision for manual
--     entries as the price of deduping them at all; as the normal path for
--     approvals it would mean half of every split day silently disappears.
--   * A corrected re-approval (declined, re-filed with fixed dates, approved)
--     would overwrite the row belonging to a different request, so deleting
--     the second request would cascade away a day the first one still
--     justifies.
--   * The two rows are not even the same claim: they are backed by different
--     approvals from possibly different managers, which is exactly the
--     distinction 0006 says the key must never destroy.
--
-- Adding source_request_id makes the key say what it always meant: one row per
-- (source, name, date), where source is now either an email or a request.
-- Within a single request the key still collapses duplicates, which is what
-- apply_leave_decision's ON CONFLICT relies on for overlapping ranges.
drop index if exists public.staff_presence_source_dedupe_key;

create unique index if not exists staff_presence_source_dedupe_key
  on public.staff_presence (source_message_id, source_request_id, lower(raw_name), on_date)
  nulls not distinct;

-- Changing an index that an ON CONFLICT clause infers is not a local change.
-- replace_presence_for_message (0007) names the old three-column key
-- explicitly, and ON CONFLICT inference is resolved at execution time against
-- the indexes that actually exist: the moment the index above replaces the old
-- one, that function starts raising "no unique or exclusion constraint
-- matching the ON CONFLICT specification" and mail-sync stops writing the
-- board entirely. Nothing in the TypeScript would look wrong, because nothing
-- in the TypeScript is.
--
-- So it is re-declared here with the new inference and nothing else changed.
-- Same signature, so presenceStore.ts's rpc() call is untouched; create or
-- replace keeps the OID, so the comment and grants from 0007 survive. The
-- reasoning in 0007's body comments still applies verbatim and is not repeated
-- — read that file, not this one, for why this is a function at all and why
-- the conflict action is DO NOTHING.
create or replace function public.replace_presence_for_message(
  p_message_id text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer;
begin
  if p_message_id is null or p_message_id = '' then
    raise exception 'replace_presence_for_message: p_message_id is required';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_presence_for_message: p_rows must be a JSON array (got %)',
      coalesce(jsonb_typeof(p_rows), 'null');
  end if;

  delete from public.staff_presence
   where source_message_id = p_message_id;

  insert into public.staff_presence (
    staff_id,
    raw_name,
    on_date,
    status,
    day_part,
    note,
    source,
    source_message_id,
    source_request_id,
    needs_review
  )
  select
    nullif(r->>'staff_id', '')::uuid,
    coalesce(r->>'raw_name', ''),
    (r->>'on_date')::date,
    r->>'status',
    coalesce(nullif(r->>'day_part', ''), 'full'),
    nullif(r->>'note', ''),
    'email',
    p_message_id,
    -- Always NULL on this path. Written explicitly rather than left to the
    -- column default so that the ON CONFLICT clause below and the row it
    -- describes are read together and cannot drift apart.
    null::uuid,
    coalesce((r->>'needs_review')::boolean, false)
  from jsonb_array_elements(p_rows) as r
  on conflict (source_message_id, source_request_id, lower(raw_name), on_date) do nothing;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

-- ---------------------------------------------------------------------------
-- Applying a decision
-- ---------------------------------------------------------------------------

-- Record a manager's decision and rebuild the presence rows that follow from
-- it, in one statement.
--
-- Delete-then-insert, not upsert, for the reason already written out in
-- replace_presence_for_message (0007): the set of rows a request justifies
-- changes shape between decisions, not just in content. Approving 12–16 and
-- then re-approving 12–14 leaves two days that no upsert would ever visit,
-- because an upsert can only touch rows it was handed. Those orphans are the
-- worst kind of wrong — an absence on the board that the request it points at
-- no longer covers. Deleting everything the request owns first makes the
-- rebuilt set exactly the set the decision implies, and reversing a decision
-- is then the same code path with an empty result.
--
-- And, as in 0007, it is a database function rather than two client round
-- trips because between those two trips the board is authoritative and wrong,
-- and because lower(raw_name) in the dedupe key is an expression index that
-- PostgREST's on_conflict= parameter cannot name.
create or replace function public.apply_leave_decision(
  p_request_id uuid,
  p_status text,
  p_decided_by uuid,
  p_note text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_written integer := 0;
begin
  if p_request_id is null then
    raise exception 'apply_leave_decision: p_request_id is required';
  end if;

  -- Only the two outcomes a manager can reach from this function. 'pending' is
  -- not a decision, and 'cancelled' belongs to the requester withdrawing, not
  -- to an approver — routing it through here would let a manager cancel
  -- somebody's leave and have it recorded as their own decision. Anything else
  -- is a caller bug. Raising rather than returning 0: a silent no-op here
  -- leaves the UI showing a decision that was never stored, which is the one
  -- failure mode nobody checks for.
  if p_status is null or p_status not in ('approved','declined') then
    raise exception 'apply_leave_decision: p_status must be approved or declined (got %)',
      coalesce(p_status, 'null');
  end if;

  update public.leave_requests
     set status = p_status,
         decided_by_profile_id = p_decided_by,
         decided_at = now(),
         decision_note = nullif(p_note, '')
   where id = p_request_id;

  -- A decision on a request that does not exist is not an empty result, it is
  -- a stale request id — a request deleted or cancelled while the manager had
  -- the queue open in another tab. Failing tells the UI to reload; succeeding
  -- would report an approval that touched nothing.
  if not found then
    raise exception 'apply_leave_decision: no leave request %', p_request_id;
  end if;

  -- Unconditional, and before the branch on status. Every row this request
  -- justifies is derived state owned entirely by this function, so the current
  -- decision starts from a clean slate whichever way it goes: a decline or a
  -- reversal simply inserts nothing afterwards and the days vanish, with no
  -- separate "undo" path that could be forgotten.
  delete from public.staff_presence
   where source_request_id = p_request_id;

  if p_status = 'approved' then
    -- An empty array is legitimate — approving leave that expands to no
    -- working days, once the caller filters weekends and public holidays.
    -- A NULL or a non-array is a caller bug, and failing loudly beats
    -- recording an approval whose days silently never appear.
    if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
      raise exception 'apply_leave_decision: p_rows must be a JSON array when approving (got %)',
        coalesce(jsonb_typeof(p_rows), 'null');
    end if;

    insert into public.staff_presence (
      staff_id,
      raw_name,
      on_date,
      status,
      day_part,
      note,
      source,
      source_message_id,
      source_request_id,
      needs_review
    )
    select
      -- Normally set: a request is filed against a roster row, so unlike an
      -- extraction there is no name to fail to resolve. Kept nullable-tolerant
      -- anyway so this path cannot be the one that raises and loses the whole
      -- approval over a single row.
      nullif(r->>'staff_id', '')::uuid,
      coalesce(r->>'raw_name', ''),
      (r->>'on_date')::date,
      r->>'status',
      coalesce(nullif(r->>'day_part', ''), 'full'),
      nullif(r->>'note', ''),
      'request',
      -- No email is involved in a request, and NULL here is what the extended
      -- dedupe key above relies on to keep request rows keyed by request.
      null::text,
      p_request_id,
      coalesce((r->>'needs_review')::boolean, false)
    from jsonb_array_elements(p_rows) as r
    -- The delete above cleared every row for this request, so the only
    -- conflicts reachable are between two rows of THIS decision — a caller
    -- that expanded overlapping ranges, or listed a day twice. First clause
    -- wins. DO NOTHING rather than DO UPDATE for the same reason 0007 gives:
    -- Postgres refuses to let one command update the same row twice, so DO
    -- UPDATE would raise on exactly the case this clause exists to survive,
    -- aborting the insert and losing every other day of the leave.
    on conflict (source_message_id, source_request_id, lower(raw_name), on_date) do nothing;

    get diagnostics v_written = row_count;
  end if;

  return v_written;
end;
$$;

comment on function public.apply_leave_decision(uuid, text, uuid, text, jsonb) is
  'Atomically record an approve/decline on a leave request and rebuild the '
  'staff_presence rows it justifies. Service role only — this is the write '
  'path that both leave_requests and staff_presence deliberately have no RLS '
  'policy for. Note what it does NOT cover: a requester CANCELLING an approved '
  'request. That keeps the request row, so the source_request_id cascade never '
  'fires, and the caller must delete the request''s staff_presence rows itself '
  '(or delete the request) or the days stay on the board.';

-- security definer means this writes both tables with the owner's rights,
-- bypassing the missing write policies on each — that is the point, and it is
-- also why nobody but the service role may call it. An authenticated session
-- with execute rights here could approve its own leave and write itself onto
-- the board, which is the entire threat the RLS shape of this file exists to
-- prevent. Postgres grants EXECUTE to PUBLIC by default, so the revoke is not
-- optional.
revoke all on function public.apply_leave_decision(uuid, text, uuid, text, jsonb) from public;
revoke all on function public.apply_leave_decision(uuid, text, uuid, text, jsonb) from anon;
revoke all on function public.apply_leave_decision(uuid, text, uuid, text, jsonb) from authenticated;

-- Granted back explicitly rather than relying on Supabase's default
-- privileges, for the reason 0007 gives: a silent "permission denied for
-- function" inside an edge function is a miserable thing to diagnose.
grant execute on function public.apply_leave_decision(uuid, text, uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.leave_requests enable row level security;

-- Read is narrower than anywhere else in this schema, and on purpose.
-- staff_presence is readable by everyone because an absence is already mailed
-- to all staff — the fact that Vidhya is out today is public within Jade. A
-- REQUEST is not: it is unapproved, it may be declined, and its reason field
-- routinely carries something medical or domestic that the person chose to
-- tell one manager. So the four ways in are the four people with a stake:
--
--   * the requester — it is their leave;
--   * the approver — it is their decision to make;
--   * whoever submitted it — an admin or office manager filing for a guard
--     with no login needs to see what they filed and what became of it;
--   * admins, via is_admin() from 0001_init.sql, because somebody has to be
--     able to answer "why is nothing moving" when a manager is themselves on
--     leave.
--
-- current_staff_id() returns NULL for a login with no roster row, and NULL = x
-- is NULL, so an unlinked session — which is most of them today — matches
-- nothing here rather than everything.
--
-- There is no insert, update or delete policy, for any role including admins;
-- see the comment on table above for why that is deliberate and must stay.
drop policy if exists leave_requests_select on public.leave_requests;
create policy leave_requests_select on public.leave_requests
  for select
  to authenticated
  using (
    requester_staff_id = public.current_staff_id()
    or approver_staff_id = public.current_staff_id()
    or submitted_by_profile_id = auth.uid()
    or public.is_admin()
  );

-- staff_directory needs no new policy for profile_id. 0006 already gives it
-- admin-only insert/update/delete through is_admin(), and those are per-table,
-- not per-column: linking a login to a person is already an admin action and
-- was the day the column did not exist. Adding a column-specific policy here
-- would be a second, drifting copy of the same rule.
--
-- staff_presence likewise keeps exactly the policies from 0006 — SELECT for
-- every authenticated user, no writes at all. source_request_id changes what a
-- row can say about itself, not who may write one.
