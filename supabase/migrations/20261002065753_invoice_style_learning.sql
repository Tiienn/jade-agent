create table public.invoice_style_examples (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null default '' check (char_length(subject) <= 200),
  original_body text not null check (char_length(original_body) between 1 and 10000),
  edited_body text not null check (char_length(edited_body) between 1 and 10000),
  created_at timestamptz not null default now()
);

create index invoice_style_examples_user_created_idx
  on public.invoice_style_examples (user_id, created_at desc);

alter table public.invoice_style_examples enable row level security;

-- These examples are read and written only by the authenticated Edge Function
-- through the service role. Keeping no client policies prevents direct browser
-- access even when someone knows the table name.
revoke all on table public.invoice_style_examples from anon, authenticated;
grant all on table public.invoice_style_examples to service_role;
