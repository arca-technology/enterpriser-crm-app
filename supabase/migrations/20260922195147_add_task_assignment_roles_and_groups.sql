alter table public.product_activity_templates
  add column template_group_id uuid,
  add column default_assignee_job_titles text[] not null default '{}'::text[];

alter table public.activities
  add column assignee_job_titles text[] not null default '{}'::text[];

with ranked as (
  select
    id,
    concat_ws(
      E'\x1f',
      lower(trim(coalesce(group_name, ''))),
      lower(trim(coalesce(sector, ''))),
      lower(trim(coalesce(channel, ''))),
      lower(trim(coalesce(activity_type, ''))),
      lower(trim(activity)),
      lower(trim(coalesce(recurrence, 'once')))
    ) as identity_key,
    row_number() over (
      partition by
        product_id,
        lower(trim(coalesce(group_name, ''))),
        lower(trim(coalesce(sector, ''))),
        lower(trim(coalesce(channel, ''))),
        lower(trim(coalesce(activity_type, ''))),
        lower(trim(activity)),
        lower(trim(coalesce(recurrence, 'once')))
      order by created_at, id
    ) as copy_number
  from public.product_activity_templates
),
group_ids as (
  select identity_key, copy_number, gen_random_uuid() as group_id
  from ranked
  group by identity_key, copy_number
)
update public.product_activity_templates as template
set template_group_id = group_ids.group_id
from ranked
join group_ids using (identity_key, copy_number)
where template.id = ranked.id;

alter table public.product_activity_templates
  alter column template_group_id set default gen_random_uuid(),
  alter column template_group_id set not null;

create index product_activity_templates_group_id_idx
  on public.product_activity_templates(template_group_id);

comment on column public.product_activity_templates.template_group_id is
  'Identifica a mesma tarefa configurada em vários produtos sem fundir clones independentes.';

comment on column public.product_activity_templates.default_assignee_job_titles is
  'Cargos que podem executar a tarefa; usuários ativos são resolvidos dinamicamente pelo cargo.';

comment on column public.activities.assignee_job_titles is
  'Cargos que podem executar a tarefa, além dos responsáveis escolhidos individualmente.';
