-- Scheduled mail sync — 09:00, 12:00, 15:00 and 17:00 Mauritius time.
--
-- pg_cron schedules in UTC and Mauritius is UTC+4 with no daylight saving, so
-- those are 05:00, 08:00, 11:00 and 13:00 UTC. No DST means these stay correct
-- year-round; a country that shifted its clocks would need re-checking.
--
-- The shared secret that authenticates the scheduler to the edge function is
-- GENERATED HERE and never leaves the database. The alternative — an env var on
-- the function plus a copy in the cron command — means the same value living in
-- two places that can silently drift, and a secret pasted into a migration or a
-- dashboard. Here Postgres owns it, the cron job reads it, and mail-sync reads
-- it back with the service role. Nothing to copy, nothing to commit.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- Scheduler credentials
-- ---------------------------------------------------------------------------

create table public.cron_config (
  -- Single-row table: the check constraint makes a second row impossible.
  id boolean primary key default true check (id),
  -- Two UUIDv4s stripped of dashes: 64 hex chars, ~244 bits of randomness.
  -- Uses core gen_random_uuid() rather than pgcrypto's gen_random_bytes so the
  -- migration carries no extension dependency.
  cron_secret text not null default (
    replace(gen_random_uuid()::text, '-', '') ||
    replace(gen_random_uuid()::text, '-', '')
  ),
  created_at timestamptz not null default now()
);

comment on table public.cron_config is
  'Single row holding the scheduler shared secret. RLS is on with NO policies, '
  'so no browser session can read it at any privilege — only the service role, '
  'which is what mail-sync runs as.';

alter table public.cron_config enable row level security;
-- Deliberately no policies. See the comment above.

insert into public.cron_config (id) values (true) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Schedule
-- ---------------------------------------------------------------------------

-- Unschedule first so re-running this migration (or editing the times) cannot
-- leave a duplicate job quietly syncing twice.
do $$
declare
  -- Named job_name, not job: a variable called `job` is ambiguous against the
  -- cron.job table inside the query below.
  job_name text;
begin
  foreach job_name in array array[
    'mail-sync-0900-mut',
    'mail-sync-1200-mut',
    'mail-sync-1500-mut',
    'mail-sync-1700-mut'
  ] loop
    if exists (select 1 from cron.job where cron.job.jobname = job_name) then
      perform cron.unschedule(job_name);
    end if;
  end loop;
end;
$$;

select cron.schedule('mail-sync-0900-mut', '0 5 * * *', $cron$
  select net.http_post(
    url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.cron_config limit 1)
    ),
    body := '{}'::jsonb
  );
$cron$);

select cron.schedule('mail-sync-1200-mut', '0 8 * * *', $cron$
  select net.http_post(
    url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.cron_config limit 1)
    ),
    body := '{}'::jsonb
  );
$cron$);

select cron.schedule('mail-sync-1500-mut', '0 11 * * *', $cron$
  select net.http_post(
    url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.cron_config limit 1)
    ),
    body := '{}'::jsonb
  );
$cron$);

select cron.schedule('mail-sync-1700-mut', '0 13 * * *', $cron$
  select net.http_post(
    url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select cron_secret from public.cron_config limit 1)
    ),
    body := '{}'::jsonb
  );
$cron$);
