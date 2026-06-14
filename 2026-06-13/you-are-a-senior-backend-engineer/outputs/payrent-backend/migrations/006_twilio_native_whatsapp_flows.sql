alter table public.users
  add column if not exists mpesa_number text;

create index if not exists users_mpesa_number_idx
on public.users (mpesa_number);

alter table public.onboarding_sessions
  add column if not exists native_flow_attempted boolean not null default false,
  add column if not exists native_flow_content_sid text,
  add column if not exists fallback_chat_active boolean not null default false;

alter table public.flow_submissions
  add column if not exists native_flow_token jsonb not null default '{}'::jsonb;
