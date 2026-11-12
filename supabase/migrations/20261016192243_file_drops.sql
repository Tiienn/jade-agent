-- A private drop shared by devices signed into the same active staff account.
-- Storage is the source of truth: no separate metadata rows can become orphaned.
insert into storage.buckets (id, name, public, file_size_limit)
values ('file-drops', 'file-drops', false, 52428800)
on conflict (id) do nothing;

create policy file_drops_select on storage.objects
for select to authenticated
using (
  bucket_id = 'file-drops'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
);

create policy file_drops_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'file-drops'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
);

create policy file_drops_delete on storage.objects
for delete to authenticated
using (
  bucket_id = 'file-drops'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and exists (select 1 from public.profiles where id = (select auth.uid()) and active)
);
