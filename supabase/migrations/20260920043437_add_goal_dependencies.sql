alter table public.product_goal_templates
  add column if not exists dependency_goal_template_ids uuid[] not null default '{}',
  add column if not exists dependency_activity_template_ids uuid[] not null default '{}';

alter table public.delivery_goals
  add column if not exists dependency_goal_ids uuid[] not null default '{}',
  add column if not exists dependency_activity_ids uuid[] not null default '{}';

comment on column public.product_goal_templates.dependency_goal_template_ids is
  'Metas-modelo que precisam ser concluídas antes desta meta.';
comment on column public.product_goal_templates.dependency_activity_template_ids is
  'Tarefas-modelo que precisam ser concluídas antes desta meta.';
comment on column public.delivery_goals.dependency_goal_ids is
  'Metas da entrega que bloqueiam o avanço desta meta.';
comment on column public.delivery_goals.dependency_activity_ids is
  'Tarefas da entrega que bloqueiam o avanço desta meta.';
