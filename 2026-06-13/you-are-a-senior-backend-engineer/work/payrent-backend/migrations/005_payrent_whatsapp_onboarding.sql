alter table public.onboarding_sessions
  add column if not exists wa_id text,
  add column if not exists selected_option text,
  add column if not exists selected_user_type text;

create index if not exists onboarding_sessions_wa_id_idx
on public.onboarding_sessions (wa_id);

alter table public.flow_submissions
  add column if not exists submission_summary jsonb not null default '{}'::jsonb;

alter table public.rent_goals
  add column if not exists savings_frequency text,
  add column if not exists target_start_date date,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create table if not exists public.savings_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  rent_goal_id uuid references public.rent_goals(id) on delete cascade,
  frequency text not null check (frequency in ('daily', 'weekly', 'monthly')),
  target_start_date date,
  channel public.notification_channel not null default 'whatsapp',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_savings_preferences_updated_at on public.savings_preferences;

create trigger set_savings_preferences_updated_at
before update on public.savings_preferences
for each row
execute function public.set_updated_at();

create index if not exists savings_preferences_user_id_idx
on public.savings_preferences (user_id);

create index if not exists savings_preferences_rent_goal_id_idx
on public.savings_preferences (rent_goal_id);
