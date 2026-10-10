-- +goose Up

-- pg_genie: Insights. The console samples every cluster every few minutes (database sizes, table sizes and dead
-- rows, transaction / row counters, connections, cache hits) and keeps the samples here; the Insights page turns
-- them into trends and forecasts. metric = what was measured, key = which database / table ('' = the cluster).
create table if not exists public.metric_samples (
  cluster_id bigint           not null references public.clusters (cluster_id) on delete cascade,
  at         timestamptz      not null,
  metric     text             not null,
  key        text             not null default '',
  value      double precision not null
);
create index if not exists metric_samples_lookup on public.metric_samples (cluster_id, metric, at);
create index if not exists metric_samples_at on public.metric_samples (at);

-- the new permission: see the Insights page (cluster-scoped). Every built-in group gets it.
update public.policies
   set permissions = array_append(permissions, 'insights.view')
 where builtin and name in ('Administrators', 'Operators', 'Viewers')
   and not ('insights.view' = any (permissions));

-- +goose Down
update public.policies set permissions = array_remove(permissions, 'insights.view') where builtin;
drop table if exists public.metric_samples;
