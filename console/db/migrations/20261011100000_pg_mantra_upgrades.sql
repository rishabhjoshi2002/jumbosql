-- +goose Up

-- pg_mantra: package upgrades of a cluster's components (PostgreSQL minor, Patroni, etcd, HAProxy, ...), run by the
-- automation container. A plan (dry run) comes first; a run keeps the installed versions on each node so a
-- rollback can put them back. result holds what each node reported.
create table if not exists public.upgrades (
  upgrade_id   bigserial   primary key,
  cluster_id   bigint      not null references public.clusters (cluster_id) on delete cascade,
  component    text        not null,
  action       text        not null check (action in ('plan', 'run', 'rollback')),
  status       text        not null default 'running' check (status in ('running', 'success', 'failed')),
  parent_id    bigint      references public.upgrades (upgrade_id) on delete set null, -- run: its plan; rollback: its run
  operation_id bigint,
  options      jsonb       not null default '{}',
  result       jsonb       not null default '[]',
  created_by   text        not null default '',
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);
create index if not exists upgrades_cluster on public.upgrades (cluster_id, created_at desc);
create index if not exists upgrades_operation on public.upgrades (operation_id);

-- the new permission: upgrade cluster components. Administrators get it.
update public.policies
   set permissions = array_append(permissions, 'upgrade.run')
 where builtin and name = 'Administrators'
   and not ('upgrade.run' = any (permissions));

-- +goose Down
update public.policies set permissions = array_remove(permissions, 'upgrade.run') where builtin;
drop table if exists public.upgrades;
