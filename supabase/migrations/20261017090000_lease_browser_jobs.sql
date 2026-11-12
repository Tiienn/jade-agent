-- Server writes only. Users may read their own jobs while their account is active.
create table public.lease_jobs (
 id uuid primary key,
 user_id uuid not null references auth.users(id) on delete cascade,
 kind text not null check (kind in ('generate','edit')),
 status text not null check (status in ('uploading','processing','ready','failed')),
 request jsonb not null,
 review jsonb,
 error text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index lease_jobs_user_created on public.lease_jobs(user_id,created_at desc);
create unique index lease_jobs_one_running on public.lease_jobs(user_id) where status in ('uploading','processing');
alter table public.lease_jobs enable row level security;
revoke all on public.lease_jobs from anon, authenticated;
grant select on public.lease_jobs to authenticated;
grant all on public.lease_jobs to service_role;
create policy lease_jobs_read on public.lease_jobs for select to authenticated using (
 user_id=(select auth.uid()) and exists(select 1 from public.profiles where id=(select auth.uid()) and active)
);
insert into storage.buckets(id,name,public,file_size_limit)
values('lease-plans','lease-plans',false,25165824);
-- No client object policies: API checks job ownership before issuing short-lived URLs.
