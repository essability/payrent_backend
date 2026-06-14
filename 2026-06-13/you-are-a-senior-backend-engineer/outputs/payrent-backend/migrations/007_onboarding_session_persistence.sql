alter table public.onboarding_sessions
  add column if not exists external_user_id text,
  add column if not exists flow_type text;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'onboarding_sessions'
      and column_name = 'wa_id'
  ) and exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'onboarding_sessions'
      and column_name = 'phone_number'
  ) then
    execute 'update public.onboarding_sessions
      set external_user_id = coalesce(external_user_id, wa_id, phone_number)
      where external_user_id is null';
  elsif exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'onboarding_sessions'
      and column_name = 'phone_number'
  ) then
    update public.onboarding_sessions
    set external_user_id = coalesce(external_user_id, phone_number)
    where external_user_id is null;
  else
    update public.onboarding_sessions
    set external_user_id = coalesce(external_user_id, id::text)
    where external_user_id is null;
  end if;
end $$;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'onboarding_sessions'
      and column_name = 'selected_user_type'
  ) then
    execute 'update public.onboarding_sessions
      set flow_type = coalesce(flow_type, data->>''flow_type'', selected_user_type, flow::text)
      where flow_type is null';
  else
    update public.onboarding_sessions
    set flow_type = coalesce(flow_type, data->>'flow_type', flow::text)
    where flow_type is null;
  end if;
end $$;

alter table public.onboarding_sessions
  alter column external_user_id set not null;

create index if not exists onboarding_sessions_external_user_id_idx
on public.onboarding_sessions (external_user_id);

create index if not exists onboarding_sessions_external_user_id_status_idx
on public.onboarding_sessions (external_user_id, status);

create index if not exists onboarding_sessions_flow_type_idx
on public.onboarding_sessions (flow_type);
