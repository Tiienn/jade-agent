-- Jade Agent — email assistant
-- Tables: mail_accounts, email_messages, email_drafts, email_rules
--
-- The mailbox connection is DELEGATED OAuth, not app-only: the user signs in
-- once at Microsoft, we keep their refresh token, and background jobs mint
-- short-lived access tokens from it. Microsoft itself then guarantees the agent
-- can only ever reach that one user's mailbox — it is not a matter of our
-- configuration being right.
--
-- Message bodies are never stored. Only the envelope fields below plus the
-- triage decision are kept; bodies are fetched from Graph when a draft is being
-- written and discarded afterwards.
--
-- Edge functions write these tables with the service role (which bypasses RLS),
-- so clients get read-only policies here — the same shape as search_logs in
-- 0001_init.sql. The one exception is email_rules, which the user manages
-- directly from the UI.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.mail_accounts (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  ms_email text not null,
  refresh_token text not null,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_error text
);

create table public.email_messages (
  id text primary key,                    -- Graph message id
  user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id text,
  from_email text,
  from_name text,
  subject text,
  received_at timestamptz,
  to_me boolean not null default false,   -- he is in To (not just Cc)
  triage text not null check (triage in ('action','fyi','ignore')),
  triage_reason text,
  web_link text,
  created_at timestamptz not null default now()
);

create table public.email_drafts (
  message_id text primary key references public.email_messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null,
  register text,
  outlook_draft_id text,
  created_at timestamptz not null default now()
);

create table public.email_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  pattern text not null,                  -- full address or bare domain
  action text not null check (action in ('ignore','prioritise')),
  created_at timestamptz not null default now(),
  unique (user_id, pattern)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The inbox list: a user's messages, newest first.
create index email_messages_user_received_idx
  on public.email_messages (user_id, received_at desc);

-- The triage tabs: "needs a reply" / "FYI" / "ignored" counts and filters.
create index email_messages_user_triage_idx
  on public.email_messages (user_id, triage);

create index email_rules_user_id_idx on public.email_rules (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.mail_accounts enable row level security;
alter table public.email_messages enable row level security;
alter table public.email_drafts enable row level security;
alter table public.email_rules enable row level security;

-- mail_accounts: RLS is enabled and NO policies are defined, deliberately.
-- With RLS on and zero policies, every client role — anon and authenticated
-- alike, including the row's own owner — is denied all access. Only the service
-- role, which bypasses RLS entirely, can read or write these rows.
--
-- Why: this table holds Microsoft refresh tokens. A refresh token is a
-- long-lived credential to the user's whole mailbox; anything that can read one
-- can read the mailbox from anywhere, forever, without the user's browser being
-- involved. There is no feature that needs a client to see it, so no policy
-- exists that could be misread, mis-scoped, or widened later by accident. The
-- app learns whether a mailbox is connected from the mail-connect /
-- mail-sync edge functions, never by selecting this table.
--
-- Do not add a policy here. If the UI needs connection status, return it from
-- an edge function instead.

-- email_messages: a user may read only their own rows. No client writes —
-- mail-sync inserts with the service role.
create policy email_messages_select on public.email_messages
  for select
  to authenticated
  using (user_id = auth.uid());

-- email_drafts: a user may read only their own rows. No client writes —
-- mail-draft inserts with the service role.
create policy email_drafts_select on public.email_drafts
  for select
  to authenticated
  using (user_id = auth.uid());

-- email_rules: a user may read, create, and delete only their own rows —
-- this is their personal ignore/prioritise list, edited from the UI via
-- supabase-js. No UPDATE policy — rules are immutable (delete and re-create
-- to change), matching pinned_folders in 0002.
create policy email_rules_select on public.email_rules
  for select
  to authenticated
  using (user_id = auth.uid());

create policy email_rules_insert on public.email_rules
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy email_rules_delete on public.email_rules
  for delete
  to authenticated
  using (user_id = auth.uid());
