-- Jade File Finder — per-user pinned folders
-- Table: pinned_folders
-- Each row is a folder a user has pinned for quick access. `path` is the
-- folder's segments relative to the project root, joined with '/'; segments
-- never contain '/'. `name` is the display label (the last segment).
-- Clients read and write their own rows directly via supabase-js under RLS.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.pinned_folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  path text not null,
  created_at timestamptz not null default now(),
  unique (user_id, path)
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

create index pinned_folders_user_id_idx on public.pinned_folders (user_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.pinned_folders enable row level security;

-- pinned_folders: a user may read, create, and delete only their own rows.
-- No UPDATE policy — pins are immutable (delete and re-create to change).
create policy pinned_folders_select on public.pinned_folders
  for select
  to authenticated
  using (user_id = auth.uid());

create policy pinned_folders_insert on public.pinned_folders
  for insert
  to authenticated
  with check (user_id = auth.uid());

create policy pinned_folders_delete on public.pinned_folders
  for delete
  to authenticated
  using (user_id = auth.uid());
