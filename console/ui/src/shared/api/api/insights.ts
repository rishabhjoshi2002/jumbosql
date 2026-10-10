// pg_genie: Insights - trends, forecasts and recommendations of a cluster (GET /clusters/{id}/insights).
import { baseApi as api } from '../baseApi.ts';

export type TPoint = { t: string; v: number };
export type BandPoint = { t: string; v: number; low: number; high: number };
export type Projection = { days: number; at: string; v: number; low: number; high: number; reliable: boolean };
export type Forecast = {
  current: number;
  per_day: number;
  /** % growth per 30 days */
  growth_pct_month: number;
  in_30_days: number;
  horizon_days: number;
  model: 'linear' | 'compound' | '';
  r2: number;
  span_days: number;
  confidence: 'low' | 'medium' | 'high';
  line: TPoint[] | null;
  /** the forecast with its likely range (95 %), from the last sample to the horizon */
  band: BandPoint[] | null;
  /** 30 / 90 / 180 / 365 days ahead */
  projections: Projection[] | null;
  has_forecast: boolean;
};
export type CapacityItem = {
  key: string;
  kind: 'storage' | 'disk' | 'cpu' | 'memory' | 'connections' | 'load' | 'database';
  title: string;
  node?: string;
  unit: 'bytes' | 'pct' | 'count' | 'per_sec';
  now: number;
  limit?: number;
  warn_at?: number;
  forecast: Forecast;
  history: TPoint[] | null;
  warn_in_days: number;
  limit_in_days: number;
  warn_date?: string;
  limit_date?: string;
  need_now?: number;
  need_at_horizon?: number;
  need_unit?: 'vcpu' | 'bytes';
  status: 'ok' | 'watch' | 'act';
  advice: string;
};
export type OutlookLine = { severity: 'critical' | 'warning' | 'info' | 'ok'; text: string };
export type InsightsOverview = {
  version: string;
  version_num: number;
  started_at: string;
  data_directory: string;
  max_connections: number;
  connections: number;
  active: number;
  idle_in_transaction: number;
  long_running: number;
  longest_seconds: number;
  cache_hit_pct: number;
  rollback_pct: number;
  xid_age_max: number;
  xid_age_database: string;
  replication_lag_seconds: number;
  standbys: number;
  shared_buffers: string;
  work_mem: string;
  pg_stat_statements: boolean;
  stats_reset: string;
};
export type InsightsTable = {
  database: string;
  name: string;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  live_rows: number;
  dead_rows: number;
  dead_pct: number;
  bloat_bytes: number;
  seq_scans: number;
  idx_scans: number;
  writes: number;
  last_vacuum?: string;
  last_analyze?: string;
  growth_bytes_per_day: number;
  in_30_days: number;
  has_trend: boolean;
};
export type InsightsHost = {
  instance: string;
  node?: string;
  role?: string;
  cores: number;
  cpu: TPoint[] | null;
  cpu_p95: number;
  cpu_forecast: Forecast;
  mem_total_bytes: number;
  mem: TPoint[] | null;
  mem_p95: number;
  mem_forecast: Forecast;
  mount?: string;
  disk_size_bytes: number;
  disk_used: TPoint[] | null;
  disk_forecast: Forecast;
  days_to_full: number;
  days_to_80pct: number;
};
export type Recommendation = {
  severity: 'critical' | 'warning' | 'info';
  category: string;
  title: string;
  detail: string;
  action?: string;
  sql?: string;
};
export type InsightsReport = {
  generated_at: string;
  cluster_id: number;
  cluster: string;
  days: number;
  collection: { enabled: boolean; interval: string; since: string; samples: number };
  overview?: InsightsOverview;
  overview_error?: string;
  storage: {
    points: TPoint[] | null;
    forecast: Forecast;
    databases: { name: string; size_bytes: number; forecast: Forecast; points: TPoint[] | null }[] | null;
  };
  load: {
    tps: TPoint[] | null;
    tps_forecast: Forecast;
    tps_peak: number;
    writes_per_sec: TPoint[] | null;
    reads_per_sec: TPoint[] | null;
    connections: TPoint[] | null;
    connections_forecast: Forecast;
    connections_peak: number;
    max_connections: number;
    cache_hit_pct: TPoint[] | null;
    temp_bytes_per_day: number;
    deadlocks_in_window: number;
  };
  tables: { database: string; databases: string[] | null; items: InsightsTable[] | null; error?: string };
  unused_indexes: { database: string; table: string; name: string; bytes: number }[] | null;
  queries:
    | {
        database: string;
        query: string;
        calls: number;
        total_ms: number;
        mean_ms: number;
        rows: number;
        hit_pct: number;
        share_pct: number;
      }[]
    | null;
  queries_error?: string;
  hosts: InsightsHost[] | null;
  hosts_source?: string;
  hosts_error?: string;
  recommendations: Recommendation[] | null;
  /** days ahead the forecasts look */
  horizon: number;
  score: number;
  grade: 'good' | 'fair' | 'poor';
  outlook: OutlookLine[] | null;
  capacity: CapacityItem[] | null;
};

export type ClusterSummary = {
  cluster_id: number;
  at: string;
  score: number;
  grade: 'good' | 'fair' | 'poor';
  critical: number;
  warning: number;
  info: number;
  top: Recommendation[] | null;
  size_bytes: number;
  size_per_day: number;
  size_in_30: number;
  size_in_365: number;
  tps_peak: number;
  connections_peak: number;
  max_connections: number;
  cpu_p95_max: number;
  disk_full_in_days: number;
  capacity_act: number;
  capacity_watch: number;
  outlook: OutlookLine[] | null;
  version?: string;
  unreachable?: string;
};
export type FleetCluster = {
  id: number;
  name: string;
  status: string;
  environment_id: number;
  servers: number;
  healthy: number;
  leader?: string;
  max_lag_bytes: number;
  summary?: ClusterSummary;
};
export type Fleet = {
  generated_at: string;
  clusters: FleetCluster[] | null;
  totals: {
    clusters: number;
    healthy: number;
    servers: number;
    critical: number;
    warning: number;
    size_bytes: number;
    size_in_30: number;
    size_in_365: number;
    size_per_day: number;
    capacity_act: number;
    capacity_watch: number;
    avg_score: number;
    worst_score: number;
  };
};

const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    getInsights: build.query<InsightsReport, { id: number; days: number; horizon?: number; database?: string }>({
      query: ({ id, days, horizon, database }) => ({
        url: `/clusters/${id}/insights`,
        params: { days, horizon: horizon ?? 30, ...(database ? { database } : {}) },
      }),
      keepUnusedDataFor: 60,
    }),
    /** every cluster of the project the user may see, worst first */
    getInsightsSummary: build.query<Fleet, { projectId: number; refresh?: boolean }>({
      query: ({ projectId, refresh }) => ({
        url: `/insights/summary`,
        params: refresh ? { project_id: projectId, refresh: true } : { project_id: projectId },
      }),
      keepUnusedDataFor: 120,
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as insightsApi };
export const { useGetInsightsQuery, useGetInsightsSummaryQuery, useLazyGetInsightsSummaryQuery } = injectedRtkApi;
