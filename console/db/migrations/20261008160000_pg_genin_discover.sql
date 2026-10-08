-- +goose Up

-- pg_genin: Discover - what was found on servers the console can reach (any PostgreSQL, built by pg_genin or
-- not). The inventory and the result are kept; the password used is never stored.
create table if not exists public.discoveries (
  discovery_id bigserial   primary key,
  name         text        not null,
  created_by   text        not null default '',
  created_at   timestamptz not null default now(),
  inventory    text        not null,
  username     text        not null default '',
  result       jsonb       not null
);
create index if not exists discoveries_created_at on public.discoveries (created_at desc);

-- the new permission: run Discover (not cluster-scoped). Administrators get it.
update public.policies
   set permissions = array_append(permissions, 'discover.run')
 where builtin and name = 'Administrators'
   and not ('discover.run' = any (permissions));

-- +goose Down
update public.policies set permissions = array_remove(permissions, 'discover.run') where builtin;
drop table if exists public.discoveries;
