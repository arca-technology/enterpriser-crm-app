create table public.company_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(trim(title)) between 3 and 180),
  category text,
  tags text[] not null default '{}'::text[],
  content text not null check (char_length(trim(content)) > 0),
  created_by uuid not null default auth.uid() references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.company_documents is
  'Documentação interna da empresa usada para consulta e treinamento da equipe.';

create index company_documents_category_idx on public.company_documents(category);
create index company_documents_updated_at_idx on public.company_documents(updated_at desc);
create index company_documents_created_by_idx on public.company_documents(created_by);

alter table public.company_documents enable row level security;

create policy authenticated_active_select
on public.company_documents
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy admin_insert
on public.company_documents
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
on public.company_documents
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
on public.company_documents
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

grant select, insert, update, delete on public.company_documents to authenticated;
revoke all on public.company_documents from anon;
