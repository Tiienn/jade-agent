-- Lease plans: shared visibility, and a record of filing a reviewed plan back
-- into SharePoint.
--
-- Two changes in one migration because they are one problem seen from two
-- sides. Until now a finished lease plan existed only in the private storage
-- folder of whoever happened to generate it: the read policy below was
-- `user_id = auth.uid()`, downloads are 120-second signed URLs, and nothing was
-- ever written back to the library. The document the firm actually sends to a
-- tenant therefore had no home and no second reader. If the person who prepared
-- it was on leave -- a state this very app tracks -- it could not be retrieved
-- at all.
--
-- `published_*` records where a copy was filed. It is written only by the
-- lease-publish function, after Microsoft confirms both files. The generated
-- DWG and PDF still never overwrite the source drawing: lease-publish writes
-- into its own output folder and asks Graph to rename on conflict, so this
-- feature cannot replace anything that already exists in SharePoint.

alter table public.lease_jobs
  add column published_at timestamptz,
  add column published_by uuid references auth.users(id) on delete set null,
  add column published jsonb;

-- A finished plan is a company record. An unfinished one is not: drafts,
-- failures and in-flight jobs stay with their owner. That split is also what
-- keeps the "you already have a plan processing" rule in the UI counting only
-- your own jobs, now that the page can see other people's.
drop policy if exists lease_jobs_read on public.lease_jobs;
create policy lease_jobs_read on public.lease_jobs for select to authenticated using (
 exists(select 1 from public.profiles p where p.id=(select auth.uid()) and p.active)
 and (
  user_id=(select auth.uid())
  or status='ready'
  or exists(select 1 from public.profiles p
             where p.id=(select auth.uid()) and p.active and p.role='admin')
 )
);

-- The shared library lists finished plans newest-first across every user, which
-- the existing (user_id, created_at) index cannot serve.
create index lease_jobs_ready_created on public.lease_jobs(created_at desc) where status='ready';
