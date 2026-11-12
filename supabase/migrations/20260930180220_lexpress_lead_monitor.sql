-- L'Express Property enquiry monitor.
--
-- Login credentials live in Supabase Vault, never in a public table. The two
-- RPCs below are callable only with the service role so the browser cannot
-- read Vault even when an administrator is signed in. The Edge Function does
-- the admin check before it calls the setter.

create table public.lexpress_monitor_config (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  sender_user_id uuid references public.profiles(id) on delete set null,
  baseline_at timestamptz,
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.lexpress_leads (
  fingerprint text primary key,
  lead_at timestamptz not null,
  civility text,
  last_name text,
  first_name text,
  email text,
  phone text,
  advert_id text,
  reference text,
  transaction text,
  property_type text,
  price text,
  currency text,
  city text,
  region text,
  agent text,
  message text,
  discovered_at timestamptz not null default now(),
  notified_at timestamptz
);

create index lexpress_leads_lead_at_idx
  on public.lexpress_leads (lead_at desc);

alter table public.lexpress_monitor_config enable row level security;
alter table public.lexpress_leads enable row level security;
-- No policies: both tables are backend-only and reached through the
-- admin/cron authenticated Edge Function.

create or replace function public.set_lexpress_credentials(
  p_email text,
  p_password text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  email_id uuid;
  password_id uuid;
begin
  select id into email_id
  from vault.decrypted_secrets
  where name = 'lexpress_login_email';

  if email_id is null then
    perform vault.create_secret(
      p_email,
      'lexpress_login_email',
      'LExpress Property professional portal login email'
    );
  else
    perform vault.update_secret(email_id, p_email);
  end if;

  select id into password_id
  from vault.decrypted_secrets
  where name = 'lexpress_login_password';

  if password_id is null then
    perform vault.create_secret(
      p_password,
      'lexpress_login_password',
      'LExpress Property professional portal login password'
    );
  else
    perform vault.update_secret(password_id, p_password);
  end if;
end;
$$;

create or replace function public.get_lexpress_credentials()
returns table (login_email text, login_password text)
language sql
security definer
set search_path = ''
as $$
  select
    max(decrypted_secret) filter (where name = 'lexpress_login_email'),
    max(decrypted_secret) filter (where name = 'lexpress_login_password')
  from vault.decrypted_secrets
  where name in ('lexpress_login_email', 'lexpress_login_password');
$$;

revoke all on function public.set_lexpress_credentials(text, text)
  from public, anon, authenticated;
revoke all on function public.get_lexpress_credentials()
  from public, anon, authenticated;
grant execute on function public.set_lexpress_credentials(text, text)
  to service_role;
grant execute on function public.get_lexpress_credentials()
  to service_role;

insert into public.lexpress_monitor_config (id)
values (true)
on conflict (id) do nothing;

-- Check hourly from 08:00 through 18:00 Mauritius time. Mauritius is UTC+4
-- year-round, so this is 04:00 through 14:00 UTC.
do $$
begin
  if exists (
    select 1 from cron.job
    where cron.job.jobname = 'lexpress-monitor-hourly-mut'
  ) then
    perform cron.unschedule('lexpress-monitor-hourly-mut');
  end if;
end;
$$;

select cron.schedule(
  'lexpress-monitor-hourly-mut',
  '0 4-14 * * *',
  $cron$
    select net.http_post(
      url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/lexpress-monitor',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-cron-secret', (select cron_secret from public.cron_config limit 1)
      ),
      body := '{}'::jsonb
    );
  $cron$
);
