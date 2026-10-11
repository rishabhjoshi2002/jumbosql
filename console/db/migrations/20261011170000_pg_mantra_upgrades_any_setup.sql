-- +goose Up

-- pg_mantra: upgrades of any setup, not only clusters in the console - a saved Discover result is a target too.
-- The upgrade keeps its own container id and log (no cluster operation row for a discovered setup).
alter table public.upgrades alter column cluster_id drop not null;
alter table public.upgrades add column if not exists discovery_id bigint references public.discoveries (discovery_id) on delete cascade;
alter table public.upgrades add column if not exists docker_id text not null default '';
alter table public.upgrades add column if not exists log text not null default '';
alter table public.upgrades add constraint upgrades_target check (cluster_id is not null or discovery_id is not null);
create index if not exists upgrades_discovery on public.upgrades (discovery_id, created_at desc);
create index if not exists upgrades_running on public.upgrades (status) where status = 'running';

-- +goose Down
drop index if exists upgrades_running;
drop index if exists upgrades_discovery;
alter table public.upgrades drop constraint if exists upgrades_target;
alter table public.upgrades drop column if exists log;
alter table public.upgrades drop column if exists docker_id;
alter table public.upgrades drop column if exists discovery_id;
