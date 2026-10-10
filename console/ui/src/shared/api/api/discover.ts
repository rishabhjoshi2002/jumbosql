// pg_genin: Discover - map any PostgreSQL servers the console can reach (POST /discover, saved results).
import { baseApi as api } from '../baseApi.ts';
import type { InsightsHost } from './insights.ts';

export type DSetting = { name: string; value: string; unit?: string };
export type DPublication = { name: string; all_tables: boolean; tables: string[] | null };
export type DSubscription = {
  name: string;
  database: string;
  enabled: boolean;
  publications: string[] | null;
  publisher_host?: string;
  publisher_port?: number;
  publisher_db?: string;
  slot_name?: string;
  receiving: boolean;
  last_message_at?: string;
  tables: number;
  tables_ready: number;
};
export type DDatabase = {
  name: string;
  owner: string;
  encoding: string;
  size_bytes: number;
  tables: number;
  extensions: string[] | null;
  publications: DPublication[] | null;
  inventory?: DInventory;
  error?: string;
};

/** everything inside one database (for migrations) */
export type DCheck = { status: 'critical' | 'warning' | 'info' | 'ok'; title: string; detail: string };
export type DTable = {
  schema: string;
  name: string;
  kind: 'table' | 'partitioned' | 'partition';
  unlogged?: boolean;
  rows: number;
  total_bytes: number;
  table_bytes: number;
  index_bytes: number;
  toast_bytes: number;
  columns: number;
  primary_key: boolean;
  replica_identity: string;
  dead_rows: number;
  seq_scans: number;
  idx_scans: number;
  last_vacuum?: string;
  last_analyze?: string;
  owner: string;
  tablespace?: string;
};
export type DIndex = {
  schema: string;
  table: string;
  name: string;
  method: string;
  size_bytes: number;
  unique: boolean;
  primary: boolean;
  valid: boolean;
  scans: number;
  definition: string;
};
export type DInventory = {
  collation?: string;
  ctype?: string;
  locale_provider?: string;
  connection_limit: number;
  tablespace?: string;
  xid_age: number;
  counts: Record<string, number>;
  schemas: { name: string; owner: string; tables: number; size_bytes: number }[];
  tables: DTable[];
  indexes: DIndex[];
  views: {
    schema: string;
    name: string;
    materialized: boolean;
    populated: boolean;
    size_bytes: number;
    owner: string;
  }[];
  functions: {
    schema: string;
    name: string;
    args: string;
    kind: string;
    language: string;
    owner: string;
    security_definer: boolean;
  }[];
  sequences: {
    schema: string;
    name: string;
    data_type: string;
    last_value: string;
    max_value: string;
    used_pct: number;
    cycle: boolean;
  }[];
  foreign_keys: { table: string; name: string; references: string; definition: string; indexed: boolean }[];
  types: { schema: string; name: string; kind: string; detail?: string }[];
  triggers: { table: string; name: string; function: string; enabled: string }[];
  foreign_servers: string[];
  column_types: { type: string; columns: number }[];
  checks: DCheck[];
  partial?: string[];
  truncated?: string[];
  largest_table?: string;
  total_rows_estimate: number;
  user_data_bytes: number;
};
export type DSender = {
  application_name: string;
  client_addr: string;
  state: string;
  sync_state: string;
  kind: 'physical' | 'logical';
  slot_name?: string;
  lag_bytes: number;
  replay_lag_seconds: number;
};
export type DSlot = {
  name: string;
  type: string;
  database?: string;
  plugin?: string;
  active: boolean;
  retained_bytes: number;
  wal_status?: string;
};
export type DRole = {
  name: string;
  superuser: boolean;
  replication: boolean;
  login: boolean;
  createdb: boolean;
  createrole: boolean;
  valid_until?: string;
};
export type DNode = {
  id: string;
  host: string;
  port: number;
  external?: boolean;
  reachable: boolean;
  error?: string;
  name?: string;
  role: 'primary' | 'standby' | 'standalone' | 'subscriber' | 'unknown' | string;
  version?: string;
  version_num?: number;
  system_id?: string;
  timeline?: number;
  started_at?: string;
  server_addr?: string;
  login_is_superuser: boolean;
  connections?: Record<string, number>;
  max_connections?: number;
  settings?: DSetting[];
  databases?: DDatabase[];
  senders?: DSender[];
  slots?: DSlot[];
  receiver?: {
    sender_host: string;
    sender_port: number;
    status: string;
    slot_name?: string;
    last_message_at?: string;
    from_config?: boolean;
  };
  subscriptions?: DSubscription[];
  roles?: DRole[];
  stack?: string[];
  patroni?: { url: string; scope?: string; role?: string; state?: string; version?: string };
  group?: string;
  partial?: string[];
};
export type DEdge = {
  from: string;
  to: string;
  kind: 'streaming' | 'logical';
  sync?: string;
  state?: string;
  lag_bytes: number;
  replay_lag_seconds: number;
  slot?: string;
  label?: string;
  healthy: boolean;
};
export type DGroup = { id: string; system_id: string; name: string; primary?: string; members: string[]; ha: string };
export type DFinding = { severity: 'critical' | 'warning' | 'info'; node?: string; text: string };
export type DResult = {
  at: string;
  architecture: string;
  summary: string[];
  nodes: DNode[];
  edges: DEdge[];
  groups: DGroup[];
  findings: DFinding[];
  infra?: DInfra;
  sizing?: DSizing;
  counts: {
    nodes: number;
    reachable: number;
    primaries: number;
    standbys: number;
    subscribers: number;
    databases: number;
    size_bytes: number;
  };
};
/** the machines and everything around PostgreSQL */
export type DComponent = {
  kind: string;
  layer: 'entry' | 'balancer' | 'pooler' | 'database' | 'ha' | 'dcs' | 'backup' | 'monitoring' | 'platform' | 'other';
  label: string;
  version?: string;
  package?: string;
  path?: string;
  running: boolean;
  ports?: number[] | null;
  sources: string[];
  details?: Record<string, string>;
  endpoint?: string;
};
export type DHost = {
  address: string;
  name?: string;
  groups?: string[] | null;
  reachable: boolean;
  open_ports: number[];
  ssh: 'ok' | 'failed' | 'not tried';
  ssh_error?: string;
  sudo?: string;
  os?: string;
  kernel?: string;
  arch?: string;
  cpus?: number;
  cpu_model?: string;
  mem_bytes?: number;
  swap_bytes?: number;
  virtualization?: string;
  booted_at?: string;
  load?: string;
  disks?: { mount: string; fs: string; size_bytes: number; used_bytes: number }[] | null;
  listening?: { port: number; addr: string; process?: string }[] | null;
  services?: string[] | null;
  packages?: { name: string; version: string }[] | null;
  components: DComponent[];
  roles: string[];
  vips?: string[] | null;
};
export type DRoute = {
  host: string;
  kind: string;
  name: string;
  port: number;
  mode?: string;
  targets: string[];
  resolved: string[];
};
export type DInfra = {
  stack: string;
  summary: string[];
  hosts: DHost[];
  routes: DRoute[];
  vips: string[];
  prometheus?: string;
  prometheus_error?: string;
  prometheus_targets?: { job: string; instance: string; health: string; host?: string }[] | null;
  ssh_used: boolean;
};
export type DSize = { cpus: number; mem_bytes: number; disk_bytes: number };
export type DHostSizing = {
  address: string;
  name: string;
  roles: string[] | null;
  pg_role?: string;
  current: DSize;
  recommended: DSize;
  cpu_peak_pct: number;
  cpu_ahead_pct: number;
  mem_peak_pct: number;
  mem_ahead_pct: number;
  disk_used_bytes: number;
  disk_ahead_bytes: number;
  status: 'right' | 'under' | 'over' | 'unknown';
  reasons: string[];
  trend?: InsightsHost;
};
export type DTuning = {
  node: string;
  host: string;
  role: string;
  for: DSize;
  changes: { name: string; current: string; recommended: string; restart: boolean; reason: string }[];
  script: string;
};
export type DSizing = {
  source: 'prometheus' | 'machines';
  prometheus?: string;
  error?: string;
  days: number;
  horizon: number;
  hosts: DHostSizing[];
  tuning: DTuning[];
  notes: string[];
};

export type Discovery = {
  id?: number;
  name: string;
  created_by?: string;
  created_at: string;
  inventory: string;
  username: string;
  result: DResult;
};
export type DiscoveryListItem = Omit<Discovery, 'result'> & { id: number; architecture: string };
export type DiscoverRequest = {
  inventory: string;
  username: string;
  password: string;
  database?: string;
  sslmode?: string;
  name?: string;
  save?: boolean;
  pg_port?: number;
  ssh_user?: string;
  ssh_port?: number;
  ssh_password?: string;
  ssh_key?: string;
  prometheus_url?: string;
  days?: number;
  horizon?: number;
};

export type QueryRequest = {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  sslmode?: string;
  sql: string;
  max_rows?: number;
};
export type QueryResult = {
  columns: string[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  duration_ms: number;
  error?: string;
};

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Discoveries'] }).injectEndpoints({
  endpoints: (build) => ({
    postDiscover: build.mutation<Discovery, DiscoverRequest>({
      query: (body) => ({ url: `/discover`, method: 'POST', body }),
      invalidatesTags: (_r, _e, arg) => (arg.save ? ['Discoveries'] : []),
    }),
    postDiscoverQuery: build.mutation<QueryResult, QueryRequest>({
      query: (body) => ({ url: `/discover/query`, method: 'POST', body }),
    }),
    getDiscoveries: build.query<DiscoveryListItem[], void>({
      query: () => ({ url: `/discoveries` }),
      providesTags: ['Discoveries'],
    }),
    getDiscovery: build.query<Discovery, number>({ query: (id) => ({ url: `/discoveries/${id}` }) }),
    deleteDiscovery: build.mutation<void, number>({
      query: (id) => ({ url: `/discoveries/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Discoveries'],
    }),
  }),
  overrideExisting: false,
});

export const {
  usePostDiscoverQueryMutation,
  usePostDiscoverMutation,
  useGetDiscoveriesQuery,
  useLazyGetDiscoveryQuery,
  useDeleteDiscoveryMutation,
} = injectedRtkApi;
