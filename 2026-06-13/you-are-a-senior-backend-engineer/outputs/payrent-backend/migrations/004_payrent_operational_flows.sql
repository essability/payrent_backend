create table if not exists public.user_transaction_pins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  pin_hash text not null,
  pin_salt text not null,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_user_transaction_pins_updated_at on public.user_transaction_pins;

create trigger set_user_transaction_pins_updated_at
before update on public.user_transaction_pins
for each row
execute function public.set_updated_at();

create index if not exists user_transaction_pins_user_id_idx
on public.user_transaction_pins (user_id);

create table if not exists public.maintenance_issues (
  id uuid primary key default gen_random_uuid(),
  reported_by_user_id uuid references public.users(id) on delete set null,
  tenant_user_id uuid references public.users(id) on delete set null,
  property_id uuid references public.properties(id) on delete set null,
  unit_id uuid references public.units(id) on delete set null,
  title text not null,
  description text not null,
  priority text not null default 'normal',
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_maintenance_issues_updated_at on public.maintenance_issues;

create trigger set_maintenance_issues_updated_at
before update on public.maintenance_issues
for each row
execute function public.set_updated_at();

create index if not exists maintenance_issues_reported_by_user_id_idx
on public.maintenance_issues (reported_by_user_id);

create index if not exists maintenance_issues_tenant_user_id_idx
on public.maintenance_issues (tenant_user_id);

create index if not exists maintenance_issues_property_id_idx
on public.maintenance_issues (property_id);

create index if not exists maintenance_issues_unit_id_idx
on public.maintenance_issues (unit_id);

create index if not exists maintenance_issues_status_idx
on public.maintenance_issues (status);
