-- +goose Up

-- pg_genin: personal home page - each user's choices (which cards, their order, the start page).
alter table public.users add column if not exists preferences jsonb not null default '{}'::jsonb;

-- pg_genin: the latest Insights summary of every cluster (health score, warnings, outlook), refreshed hourly by
-- the console, so the multi-cluster summary needs no live work per cluster.
create table if not exists public.insight_reports (
  cluster_id bigint      primary key references public.clusters (cluster_id) on delete cascade,
  at         timestamptz not null,
  summary    jsonb       not null
);

-- +goose Down
drop table if exists public.insight_reports;
alter table public.users drop column if exists preferences;
