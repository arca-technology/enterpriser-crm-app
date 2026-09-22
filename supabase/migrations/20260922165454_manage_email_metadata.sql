alter table public.client_email_accounts
  alter column company_id drop not null,
  alter column password_ciphertext drop not null,
  add column tags text[] not null default '{}'::text[];

comment on column public.client_email_accounts.password_ciphertext is
  'Senha conhecida pelo CRM. Pode ser nula para contas preexistentes no cPanel.';

comment on column public.client_email_accounts.tags is
  'Marcadores operacionais do CRM; não alteram a conta no cPanel.';
