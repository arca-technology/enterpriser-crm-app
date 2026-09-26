alter table public.product_activity_templates
  add column if not exists parent_template_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'product_activity_templates_parent_template_id_fkey'
      and conrelid = 'public.product_activity_templates'::regclass
  ) then
    alter table public.product_activity_templates
      add constraint product_activity_templates_parent_template_id_fkey
      foreign key (parent_template_id)
      references public.product_activity_templates(id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'product_activity_templates_parent_not_self'
      and conrelid = 'public.product_activity_templates'::regclass
  ) then
    alter table public.product_activity_templates
      add constraint product_activity_templates_parent_not_self
      check (parent_template_id is null or parent_template_id <> id);
  end if;
end $$;

create index if not exists product_activity_templates_parent_template_id_idx
  on public.product_activity_templates(parent_template_id)
  where parent_template_id is not null;
