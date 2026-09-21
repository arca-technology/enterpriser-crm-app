create index client_email_accounts_company_id_idx
  on public.client_email_accounts(company_id);

create index client_email_accounts_delivery_id_idx
  on public.client_email_accounts(delivery_id)
  where delivery_id is not null;

create index client_email_accounts_created_by_idx
  on public.client_email_accounts(created_by);
