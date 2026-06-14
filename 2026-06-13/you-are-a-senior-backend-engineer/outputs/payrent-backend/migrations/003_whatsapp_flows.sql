create table if not exists public.flow_submissions (
  id uuid primary key default gen_random_uuid(),

  flow_name text not null,
  source text not null default 'whatsapp',

  phone_number text,
  user_id uuid references public.users(id) on delete set null,

  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,

  status text not null default 'received',
  error_message text,

  created_at timestamptz not null default now()
);

create index if not exists flow_submissions_flow_name_idx
on public.flow_submissions (flow_name);

create index if not exists flow_submissions_phone_number_idx
on public.flow_submissions (phone_number);

create index if not exists flow_submissions_user_id_idx
on public.flow_submissions (user_id);

create index if not exists flow_submissions_created_at_idx
on public.flow_submissions (created_at);
