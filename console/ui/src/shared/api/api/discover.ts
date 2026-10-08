// pg_genin: Discover - map any PostgreSQL servers the console can reach (POST /discover, saved results).
import { baseApi as api } from '../baseApi.ts';

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
  error?: string;
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
};

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Discoveries'] }).injectEndpoints({
  endpoints: (build) => ({
    postDiscover: build.mutation<Discovery, DiscoverRequest>({
      query: (body) => ({ url: `/discover`, method: 'POST', body }),
      invalidatesTags: (_r, _e, arg) => (arg.save ? ['Discoveries'] : []),
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

export const { usePostDiscoverMutation, useGetDiscoveriesQuery, useLazyGetDiscoveryQuery, useDeleteDiscoveryMutation } =
  injectedRtkApi;
