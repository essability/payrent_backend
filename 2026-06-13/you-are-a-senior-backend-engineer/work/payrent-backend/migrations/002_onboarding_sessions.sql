create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'onboarding_flow') then
    create type public.onboarding_flow as enum (
      'independent_tenant',
      'tenant_invitation',
      'landlord',
      'property_manager',
      'caretaker'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'onboarding_status') then
    create type public.onboarding_status as enum (
      'active',
      'completed',
      'cancelled',
      'expired'
    );
  end if;
end $$;

create table if not exists public.onboarding_sessions (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  user_id uuid references public.users(id) on delete set null,
  flow public.onboarding_flow not null,
  status public.onboarding_status not null default 'active',
  current_step text not null,
  data jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_onboarding_sessions_updated_at on public.onboarding_sessions;

create trigger set_onboarding_sessions_updated_at
before update on public.onboarding_sessions
for each row
execute function public.set_updated_at();

create index if not exists onboarding_sessions_phone_number_idx
on public.onboarding_sessions (phone_number);

create index if not exists onboarding_sessions_phone_number_status_idx
on public.onboarding_sessions (phone_number, status);

create index if not exists onboarding_sessions_expires_at_idx
on public.onboarding_sessions (expires_at);
