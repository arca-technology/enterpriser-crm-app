create table public.company_files (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'active' check (status in ('active', 'inactive', 'downloaded')),
  client text,
  company_id text not null references public.companies(tax_id) on update cascade on delete restrict,
  sector_1 text,
  sector_2 text,
  sector_3 text,
  sector_4 text,
  sector_5 text,
  file_reference text not null check (char_length(trim(file_reference)) > 0),
  file_date date,
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_files is
  'Catálogo de arquivos e links organizados por empresa, cliente e setores.';

create index company_files_company_id_idx on public.company_files(company_id);
create index company_files_status_idx on public.company_files(status);
create index company_files_file_date_idx on public.company_files(file_date desc);
create index company_files_created_by_idx on public.company_files(created_by);

alter table public.company_files enable row level security;

create policy authenticated_active_select
on public.company_files
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy admin_insert
on public.company_files
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
on public.company_files
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
on public.company_files
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

grant select, insert, update, delete on public.company_files to authenticated;
revoke all on public.company_files from anon;
