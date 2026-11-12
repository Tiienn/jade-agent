-- Private snippets shared by devices signed into one active staff account.
create table public.shared_texts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  content text not null check (char_length(btrim(content)) > 0 and char_length(content) <= 10000),
  created_at timestamptz not null default now()
);
create index shared_texts_user_created_idx on public.shared_texts (user_id, created_at desc);
alter table public.shared_texts enable row level security;
grant select, insert, delete on public.shared_texts to authenticated;

create policy shared_texts_select on public.shared_texts for select to authenticated
using (user_id = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and active
));
create policy shared_texts_insert on public.shared_texts for insert to authenticated
with check (user_id = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and active
));
create policy shared_texts_delete on public.shared_texts for delete to authenticated
using (user_id = (select auth.uid()) and exists (
  select 1 from public.profiles where id = (select auth.uid()) and active
));

-- Presence and invalidation messages stay in a private, account-specific room.
-- Payloads contain only device IDs and snapshot hashes, never text or file bytes.
create policy share_room_read on realtime.messages for select to authenticated
using (
  realtime.topic() = 'share:' || (select auth.uid())::text
  and extension in ('presence', 'broadcast')
  and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
);
create policy share_room_write on realtime.messages for insert to authenticated
with check (
  realtime.topic() = 'share:' || (select auth.uid())::text
  and extension in ('presence', 'broadcast')
  and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
);
