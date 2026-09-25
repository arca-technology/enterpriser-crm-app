alter table public.company_documents
  add column if not exists orientation text not null default 'landscape';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_documents_orientation_check'
      and conrelid = 'public.company_documents'::regclass
  ) then
    alter table public.company_documents
      add constraint company_documents_orientation_check
      check (orientation in ('landscape', 'portrait'));
  end if;
end $$;

alter table public.activities
  add column if not exists parent_activity_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'activities_parent_activity_id_fkey'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_parent_activity_id_fkey
      foreign key (parent_activity_id)
      references public.activities(id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'activities_parent_activity_not_self'
      and conrelid = 'public.activities'::regclass
  ) then
    alter table public.activities
      add constraint activities_parent_activity_not_self
      check (parent_activity_id is null or parent_activity_id <> id);
  end if;
end $$;

create index if not exists activities_parent_activity_id_idx
  on public.activities(parent_activity_id)
  where parent_activity_id is not null;
