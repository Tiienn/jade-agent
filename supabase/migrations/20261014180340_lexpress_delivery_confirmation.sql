alter table public.lexpress_monitor_config
  add column last_delivery_status text
    check (last_delivery_status in ('accepted', 'confirmed')),
  add column last_message_id text,
  add column last_sent_web_link text;

comment on column public.lexpress_monitor_config.last_delivery_status is
  'accepted means Graph queued the send; confirmed means the message was found in Sent Items';
