alter table public.company_documents
  add column slides jsonb not null default '[]'::jsonb
  check (jsonb_typeof(slides) = 'array');

comment on column public.company_documents.slides is
  'Slides textuais da documentação, incluindo título, HTML sanitizado e cor de fundo.';

create table public.contact_companies (
  contact_id uuid not null references public.contacts(id) on update cascade on delete cascade,
  company_id text not null references public.companies(tax_id) on update cascade on delete cascade,
  created_at timestamptz not null default now(),
  primary key (contact_id, company_id)
);

comment on table public.contact_companies is
  'Relacionamento muitos-para-muitos entre pessoas e empresas.';

insert into public.contact_companies (contact_id, company_id)
select id, company_id
from public.contacts
where company_id is not null
on conflict do nothing;

create index contact_companies_company_id_idx
  on public.contact_companies(company_id);

alter table public.contact_companies enable row level security;

create policy authenticated_active_select
on public.contact_companies
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy admin_insert
on public.contact_companies
for insert
to authenticated
with check (
  (select private.crm_has_active_access())
  and exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

create policy admin_delete
on public.contact_companies
for delete
to authenticated
using (
  exists (
    select 1 from public.profiles
    where auth_user_id = (select auth.uid()) and role = 'admin' and status = 'active'
  )
);

grant select, insert, delete on public.contact_companies to authenticated;
revoke all on public.contact_companies from anon;
