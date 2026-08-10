-- Jade Agent — who is allowed to announce an absence, and how those absences
-- are written.
--
-- Two things live here, and they exist for the same reason: the presence board
-- is only as trustworthy as the gate in front of it.
--
--   1. presence_announcers — the senders whose all-staff mails are read as
--      staff records at all. isPresenceEmail() in _shared/presence.ts refuses
--      to parse anything from an address that is not in this table, so this is
--      the hard perimeter: a supplier apologising for being off sick cannot
--      book himself onto the Jade board.
--   2. replace_presence_for_message() — the ONLY way an extraction reaches
--      staff_presence, replacing an email's previous rows atomically.
--
-- Why a table and not a constant in the edge function: the set of people who
-- send these notices changes with staffing. Melanie is the office manager
-- today; when she is on leave someone covers for her, and when she moves on
-- somebody else takes it over entirely. A constant would make each of those an
-- edit, a review and a redeploy — so the notices would simply stop being read
-- for a week until somebody noticed the board had gone quiet. Admins add and
-- remove announcers from the Settings UI instead.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.presence_announcers (
  -- The address IS the identity, so it is the key. Stored lowercase because
  -- every comparison against it is lowercase (see isPresenceEmail, which
  -- normalises the sender before matching); keeping the raw casing here would
  -- mean one address could be seeded twice, 'Melanie.Lau@' and 'melanie.lau@',
  -- with only one of them ever matching.
  email text primary key,
  -- Free text, for the UI only: 'Office Manager', 'Reception (cover)'. Not a
  -- role the code branches on — every announcer is equally believed.
  label text,
  -- Deactivate rather than delete when somebody stops sending these. The
  -- presence rows they produced stay explainable, and reinstating a holiday
  -- stand-in is a toggle rather than retyping an address.
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.presence_announcers is
  'Senders whose all-staff mail is parsed into staff_presence. This is the '
  'security boundary for the presence board: extraction refuses any address '
  'not listed here and active, so an outsider cannot assert an absence for a '
  'colleague. Admin-writable via RLS, using the same is_admin() helper that '
  'guards buildings in 0001_init.sql and staff_directory in 0006.';

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------

-- Exactly one row, and only because this address is confirmed from live mail
-- in the connected mailbox. Every other announcer is added through the
-- Settings UI by an admin who knows the address is right. Guessing a second
-- one here would either do nothing (a typo'd address never matches) or, worse,
-- be wrong in a way that looks configured and correct.
insert into public.presence_announcers (email, label, active)
values ('melanie.lau@jadegroup.mu', 'Office Manager', true)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.presence_announcers enable row level security;

-- Read to every authenticated user: the Settings page shows the list, and the
-- board's "where did this come from?" explanation names the sender. There is
-- no secret in an address that already appears in everyone's inbox.
drop policy if exists presence_announcers_select on public.presence_announcers;
create policy presence_announcers_select on public.presence_announcers
  for select
  to authenticated
  using (true);

-- Writes are admin-only. Adding an announcer grants an address the power to
-- write staff records for the whole company, which is not a thing a worker
-- account should be able to do.
drop policy if exists presence_announcers_insert on public.presence_announcers;
create policy presence_announcers_insert on public.presence_announcers
  for insert
  to authenticated
  with check (public.is_admin());

drop policy if exists presence_announcers_update on public.presence_announcers;
create policy presence_announcers_update on public.presence_announcers
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

drop policy if exists presence_announcers_delete on public.presence_announcers;
create policy presence_announcers_delete on public.presence_announcers
  for delete
  to authenticated
  using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Atomic replacement of one email's presence rows
-- ---------------------------------------------------------------------------

-- Replace every staff_presence row extracted from one email with a new set.
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT AN UPSERT FROM THE EDGE FUNCTION:
--
--   * The dedupe index in 0006 is staff_presence_source_dedupe_key, on
--     (source_message_id, lower(raw_name), on_date). lower(raw_name) makes it
--     an EXPRESSION index, and PostgREST's `on_conflict=` parameter can only
--     name columns — it cannot express lower(raw_name). So supabase-js
--     .upsert() literally cannot target the key that defines "the same
--     assertion", and would fall back to inserting duplicates or erroring.
--   * The obvious workaround from the client — delete the message's rows, then
--     insert the new ones — is two round trips over the public internet. In
--     between, the board is authoritative and WRONG: an absence that is still
--     true has vanished, and anyone reading the page in that window is told a
--     sick colleague is at their desk. Re-syncing the same mail is routine
--     (see the sinceHours re-scan in mail-sync), so that window would be hit
--     regularly, not theoretically.
--
-- Inside here both statements run within the single statement that calls the
-- function, so no other session ever observes the gap between them, and any
-- failure rolls the whole replacement back rather than leaving the email half
-- recorded.
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
  -- Without a message id the delete would have no anchor and the insert would
  -- write rows that no re-sync could ever replace.
  if p_message_id is null or p_message_id = '' then
    raise exception 'replace_presence_for_message: p_message_id is required';
  end if;

  -- An empty array is a legitimate, meaningful call: an email whose absences
  -- were retracted or re-worded must clear what it previously asserted. A NULL
  -- or a non-array is a caller bug, and failing loudly beats silently deleting
  -- an email's rows and writing nothing back.
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
    needs_review
  )
  select
    -- '' and JSON null both mean "unresolved name". Not an error: 0006 makes
    -- staff_id nullable precisely so an unresolved absence is still recorded.
    nullif(r->>'staff_id', '')::uuid,
    coalesce(r->>'raw_name', ''),
    (r->>'on_date')::date,
    r->>'status',
    coalesce(nullif(r->>'day_part', ''), 'full'),
    nullif(r->>'note', ''),
    'email',
    p_message_id,
    coalesce((r->>'needs_review')::boolean, false)
  from jsonb_array_elements(p_rows) as r
  -- The delete above removed every row for this message, so the only conflicts
  -- reachable here are between two rows of THIS email — one notice naming the
  -- same person twice for the same day ("Sandy has already left office and
  -- will be late"). The first clause wins and the second is dropped, which is
  -- the least-bad option: raising would abort the insert and lose every OTHER
  -- person named in the same email, which is a far bigger hole in the board
  -- than one duplicated name.
  --
  -- DO NOTHING rather than DO UPDATE on purpose. Postgres refuses to let one
  -- command update the same row twice ("ON CONFLICT DO UPDATE command cannot
  -- affect row a second time"), so DO UPDATE would raise on precisely the case
  -- this clause exists to survive. DO NOTHING handles a self-conflict within
  -- the statement.
  on conflict (source_message_id, lower(raw_name), on_date) do nothing;

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function public.replace_presence_for_message(text, jsonb) is
  'Atomically replace the staff_presence rows extracted from one email. '
  'Service role only — this is the write path that staff_presence has no RLS '
  'policy for, and it deliberately bypasses the browser entirely.';

-- security definer means this function writes staff_presence with the table
-- owner's rights, bypassing the "no write policy" rule from 0006. That is the
-- whole point, and it is also why nobody but the service role may call it: an
-- authenticated browser session with execute rights here could assert any
-- absence for any colleague, which is exactly what 0006's missing write policy
-- exists to prevent. Postgres grants EXECUTE to PUBLIC by default, so the
-- revoke is not optional.
revoke all on function public.replace_presence_for_message(text, jsonb) from public;
revoke all on function public.replace_presence_for_message(text, jsonb) from anon;
revoke all on function public.replace_presence_for_message(text, jsonb) from authenticated;

-- Granted back explicitly rather than left to Supabase's default privileges.
-- Those defaults would cover it today, but the revoke above is the kind of line
-- that gets copied into the next migration, and a silent "permission denied for
-- function" in a background sync is a miserable thing to diagnose.
grant execute on function public.replace_presence_for_message(text, jsonb) to service_role;
