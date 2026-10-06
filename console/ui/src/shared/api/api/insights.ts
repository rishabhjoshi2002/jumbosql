// JumboSQL: Insights - trends, forecasts and recommendations of a cluster (GET /clusters/{id}/insights).
import { baseApi as api } from '../baseApi.ts';

export type TPoint = { t: string; v: number };
export type Forecast = {
  current: number;
  per_day: number;
  in_30_days: number;
  horizon_days: number;
  r2: number;
  span_days: number;
  confidence: 'low' | 'medium' | 'high';
  line: TPoint[] | null;
  has_forecast: boolean;
};
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
};

const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    getInsights: build.query<InsightsReport, { id: number; days: number; database?: string }>({
      query: ({ id, days, database }) => ({
        url: `/clusters/${id}/insights`,
        params: database ? { days, database } : { days },
      }),
      keepUnusedDataFor: 60,
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as insightsApi };
export const { useGetInsightsQuery } = injectedRtkApi;
