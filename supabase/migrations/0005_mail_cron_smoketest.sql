-- Fire the scheduled sync once, immediately, using the EXACT statement the four
-- cron jobs run (see 0004).
--
-- Why this exists: the scheduler authenticates with a secret that lives only in
-- the database, so the cron → edge function path cannot be exercised from a
-- terminal or the app. Without this, the first proof that scheduling works
-- would be the 09:00 run — and a silent failure there looks identical to "no
-- new mail". Firing it at deploy time turns that into an immediate,
-- observable result: mail_accounts.last_sync_at moves.
--
-- Safe to re-run: the effect is one extra mail sync, which is idempotent.

select net.http_post(
  url := 'https://nfnpwkkcafaumxrqjdai.supabase.co/functions/v1/mail-sync',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', (select cron_secret from public.cron_config limit 1)
  ),
  body := '{}'::jsonb
);
