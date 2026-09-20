drop policy if exists authenticated_active_all on public.profiles;

create policy authenticated_active_select
  on public.profiles
  for select
  to authenticated
  using ((select private.crm_has_active_access()));

comment on policy authenticated_active_select on public.profiles is
  'Active CRM users may read assignee profiles. Profile writes are restricted to the administrative Edge Function using service role.';
