create table public.training_processes (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 3 and 160),
  area text,
  system_name text,
  objective text,
  reference_url text,
  audience text,
  responsible_job_title text,
  difficulty text not null default 'basic' check (difficulty in ('basic', 'intermediate', 'advanced')),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes between 1 and 1440),
  tags text[] not null default '{}'::text[],
  steps jsonb not null default '[]'::jsonb check (jsonb_typeof(steps) = 'array'),
  version integer not null default 1 check (version > 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.training_processes is
  'Procedimentos operacionais usados para consulta e treinamento da equipe.';

create index training_processes_status_idx on public.training_processes(status);
create index training_processes_area_idx on public.training_processes(area);
create index training_processes_updated_at_idx on public.training_processes(updated_at desc);

alter table public.training_processes enable row level security;

create policy authenticated_active_select
on public.training_processes
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy admin_insert
on public.training_processes
for insert
to authenticated
with check (
  (select private.crm_has_active_access())
  and created_by = (select auth.uid())
  and exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

create policy admin_update
on public.training_processes
for update
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
)
with check (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

create policy admin_delete
on public.training_processes
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

grant select, insert, update, delete on public.training_processes to authenticated;
revoke all on public.training_processes from anon;
