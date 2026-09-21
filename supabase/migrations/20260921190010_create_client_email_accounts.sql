create table public.client_email_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id text not null references public.companies(tax_id) on update cascade on delete restrict,
  delivery_id uuid references public.deliveries(id) on delete set null,
  client_name text not null,
  email text not null unique,
  password_ciphertext text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_email_accounts is
  'Contas de clientes criadas no cPanel. Senhas são armazenadas somente como AES-256-GCM.';

alter table public.client_email_accounts enable row level security;

create policy authenticated_active_select
on public.client_email_accounts
for select
to authenticated
using ((select private.crm_has_active_access()));

create policy authenticated_active_insert
on public.client_email_accounts
for insert
to authenticated
with check (
  (select private.crm_has_active_access())
  and created_by = (select auth.uid())
);

grant select, insert on public.client_email_accounts to authenticated;
revoke all on public.client_email_accounts from anon;
