alter table public.training_processes
  add column if not exists category text;

update public.training_processes
set category = nullif(trim(area), '')
where category is null;

update public.training_processes as process
set steps = (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', coalesce(nullif(step.item ->> 'id', ''), gen_random_uuid()::text),
        'system', coalesce(nullif(step.item ->> 'system', ''), nullif(process.system_name, ''), ''),
        'module', coalesce(nullif(step.item ->> 'module', ''), nullif(step.item ->> 'title', ''), ''),
        'submodule', coalesce(step.item ->> 'submodule', ''),
        'group', coalesce(step.item ->> 'group', ''),
        'type', coalesce(step.item ->> 'type', ''),
        'url', coalesce(nullif(step.item ->> 'url', ''), nullif(process.reference_url, ''), ''),
        'details', coalesce(nullif(step.item ->> 'details', ''), step.item ->> 'instruction', '')
      )
      order by step.position
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(process.steps) with ordinality as step(item, position)
)
where jsonb_array_length(process.steps) > 0;

create index if not exists training_processes_category_idx
  on public.training_processes(category);

comment on column public.training_processes.category is
  'Categoria principal usada para organizar os processos de treinamento.';

comment on column public.training_processes.steps is
  'Etapas ordenadas com sistema, modulo, submodulo, grupo, tipo, URL e detalhes.';
