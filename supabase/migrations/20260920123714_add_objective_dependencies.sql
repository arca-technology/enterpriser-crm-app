+alter table public.product_objective_templates
  add column if not exists dependency_objective_template_ids uuid[] not null default '{}',
  add column if not exists dependency_activity_template_ids uuid[] not null default '{}';

alter table public.delivery_objectives
  add column if not exists dependency_objective_ids uuid[] not null default '{}',
  add column if not exists dependency_activity_ids uuid[] not null default '{}';

comment on column public.product_objective_templates.dependency_objective_template_ids is
  'Objetivos-modelo que precisam ser concluídos antes deste objetivo.';
comment on column public.product_objective_templates.dependency_activity_template_ids is
  'Tarefas-modelo que precisam ser concluídas antes deste objetivo.';
comment on column public.delivery_objectives.dependency_objective_ids is
  'Objetivos da entrega que bloqueiam o avanço deste objetivo.';
comment on column public.delivery_objectives.dependency_activity_ids is
  'Tarefas da entrega que bloqueiam o avanço deste objetivo.';
