-- +goose Up

-- JumboSQL: attribute-based access control (policies only), audit log and SQL editor database roles.
--
-- A policy grants (effect 'allow') or takes away (effect 'deny') permissions to the users it matches
-- (by name or by user attributes), on the clusters it matches (by name, environment or project), under
-- optional conditions (client IP ranges, weekdays and hours). Deny wins over allow. Nothing is allowed
-- without a matching allow policy. The SQL data scope of a policy (databases, schemas, tables, hidden
-- columns) is enforced inside PostgreSQL through a console-managed role with column-level grants.

alter table public.users add column if not exists attributes jsonb not null default '{}'::jsonb;
-- the former fixed role becomes the attribute "group", which the built-in policies match on
update public.users set attributes = attributes || jsonb_build_object('group', role)
 where not attributes ? 'group';
alter table public.users drop constraint if exists users_role_check;

create table if not exists public.policies (
  policy_id   bigserial primary key,
  name        text        not null,
  description text,
  effect      text        not null default 'allow' check (effect in ('allow', 'deny')),
  enabled     boolean     not null default true,
  builtin     boolean     not null default false,
  -- {"everyone": bool, "users": ["alice"], "attributes": {"team": ["payments", "core"], "level": ["senior"]}}
  subjects    jsonb       not null default '{}'::jsonb,
  -- e.g. ["clusters.view", "patroni.read", "sql.read"]
  permissions text[]      not null default '{}',
  -- {"clusters": ["prod-*"], "environments": ["production"], "projects": ["default"]}; empty = all clusters
  resources   jsonb       not null default '{}'::jsonb,
  -- {"databases": ["app*"], "schemas": ["public"], "tables": ["public.*"],
  --  "hidden_columns": ["public.customers.email", "*.*.ssn"], "max_rows": 1000, "timeout_seconds": 60}
  data        jsonb       not null default '{}'::jsonb,
  -- {"ip_ranges": ["10.0.0.0/8"], "weekdays": [1,2,3,4,5], "hours": "08:00-20:00", "timezone": "Asia/Kolkata"}
  conditions  jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  updated_by  text
);
create unique index if not exists policies_name_uidx on public.policies (lower(name));

insert into public.policies (name, description, effect, builtin, subjects, permissions)
values
  ('Administrators', 'Everything, including users, policies and the audit log; SQL as the cluster superuser.',
   'allow', true, '{"attributes": {"group": ["admin"]}}',
   array['clusters.view', 'clusters.manage', 'patroni.read', 'patroni.manage', 'sql.read', 'sql.write', 'sql.admin',
         'sql.stats', 'logs.view', 'observability.manage', 'settings.manage', 'users.manage', 'policies.manage',
         'audit.view']),
  ('Operators', 'Create and run clusters, Patroni actions, PostgreSQL logs; SQL with read and write access.',
   'allow', true, '{"attributes": {"group": ["operator"]}}',
   array['clusters.view', 'clusters.manage', 'patroni.read', 'patroni.manage', 'sql.read', 'sql.write', 'sql.stats',
         'logs.view', 'observability.manage']),
  ('Viewers', 'Read-only: cluster pages, Patroni status, observability; SQL read-only.',
   'allow', true, '{"attributes": {"group": ["viewer"]}}',
   array['clusters.view', 'patroni.read', 'sql.read'])
on conflict do nothing;

-- Who did what. Kept 180 days by default (PG_CONSOLE_AUDIT_RETENTION).
create table if not exists public.audit_events (
  event_id   bigserial primary key,
  at         timestamptz not null default now(),
  user_id    bigint,
  username   text        not null,
  client_ip  text,
  action     text        not null,   -- e.g. sql.run, patroni.switchover, auth.login, access.denied, policies.update
  method     text,
  path       text,
  cluster_id bigint,
  outcome    text        not null check (outcome in ('ok', 'denied', 'error')),
  status     integer,
  details    jsonb       not null default '{}'::jsonb
);
create index if not exists audit_events_at_idx on public.audit_events (at desc);
create index if not exists audit_events_user_idx on public.audit_events (lower(username), at desc);
create index if not exists audit_events_action_idx on public.audit_events (action, at desc);
create index if not exists audit_events_cluster_idx on public.audit_events (cluster_id, at desc);

-- PostgreSQL roles the console manages on each cluster for the SQL editor (one per data profile).
create table if not exists public.sql_roles (
  cluster_id   bigint      not null references public.clusters (cluster_id) on delete cascade,
  role_name    text        not null,
  password_enc bytea       not null,
  profile      jsonb       not null default '{}'::jsonb,
  synced       jsonb       not null default '{}'::jsonb,  -- {"<database>": "<timestamp of the last grant sync>"}
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  primary key (cluster_id, role_name)
);

-- +goose Down
drop table if exists public.sql_roles;
drop table if exists public.audit_events;
drop table if exists public.policies;
alter table public.users drop column if exists attributes;
