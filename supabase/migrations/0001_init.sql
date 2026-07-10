-- Jade File Finder — initial schema
-- Tables: profiles, buildings, search_logs
-- Auth is username+password mapped to synthetic emails; roles are 'admin' | 'worker'.
-- Account management and search-log inserts happen through edge functions using the
-- service role (which bypasses RLS), so clients get read-only policies here.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  display_name text not null,
  role text not null check (role in ('admin','worker')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.buildings (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  root_path text not null,
  created_at timestamptz not null default now()
);

create table public.search_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  username text not null,
  query text not null,
  parsed jsonb,
  result_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index search_logs_user_id_idx on public.search_logs (user_id);
create index search_logs_created_at_idx on public.search_logs (created_at desc);
create index profiles_username_idx on public.profiles (username);

-- ---------------------------------------------------------------------------
-- Helper: is_admin()
-- security definer + stable so RLS policies can call it without recursing into
-- the profiles RLS policies. Fixed search_path guards against hijacking.
-- ---------------------------------------------------------------------------

create function public.is_admin()
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and active
  );
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.buildings enable row level security;
alter table public.search_logs enable row level security;

-- profiles: a user may read their own row; admins may read all.
-- No client INSERT/UPDATE/DELETE — account management goes through the
-- admin-users edge function with the service role.
create policy profiles_select on public.profiles
  for select
  using (id = auth.uid() or public.is_admin());

-- buildings: any authenticated user may read; only admins may modify.
-- Admins edit these directly from the Settings page via supabase-js.
create policy buildings_select on public.buildings
  for select
  to authenticated
  using (true);

create policy buildings_insert on public.buildings
  for insert
  to authenticated
  with check (public.is_admin());

create policy buildings_update on public.buildings
  for update
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy buildings_delete on public.buildings
  for delete
  to authenticated
  using (public.is_admin());

-- search_logs: a user may read their own rows; admins may read all.
-- No client writes — the search edge function inserts with the service role.
create policy search_logs_select on public.search_logs
  for select
  using (user_id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------------------
-- Seed: 9 buildings. root_path = 'Marketing/Project/' + name
-- ---------------------------------------------------------------------------

insert into public.buildings (code, name, root_path) values
  ('RT',  'Raffles Tower',      'Marketing/Project/Raffles Tower'),
  ('AH',  'Alexander House',    'Marketing/Project/Alexander House'),
  ('AC',  'Arcades Cliderlex',  'Marketing/Project/Arcades Cliderlex'),
  ('FSB', 'Fon Sing Building',  'Marketing/Project/Fon Sing Building'),
  ('JC',  'Jade Court',         'Marketing/Project/Jade Court'),
  ('JH',  'Jade House',         'Marketing/Project/Jade House'),
  ('M',   'Manhattan',          'Marketing/Project/Manhattan'),
  ('W',   'Windsor',            'Marketing/Project/Windsor'),
  ('PS',  'Palm Square',        'Marketing/Project/Palm Square');
