// JumboSQL: access policies, audit log, PostgreSQL logs and SQL access (see console/service/api/swagger.yaml).
import { baseApi as api } from '../baseApi.ts';

export type PolicySubjects = { everyone?: boolean; users?: string[]; attributes?: Record<string, string[]> };
export type PolicyResources = { clusters?: string[]; environments?: string[]; projects?: string[] };
export type PolicyData = {
  databases?: string[];
  schemas?: string[];
  tables?: string[];
  hidden_columns?: string[];
  max_rows?: number;
  timeout_seconds?: number;
};
export type PolicyConditions = { ip_ranges?: string[]; weekdays?: number[]; hours?: string; timezone?: string };

export type Policy = {
  id?: number;
  name: string;
  description?: string;
  effect: 'allow' | 'deny';
  enabled: boolean;
  builtin?: boolean;
  subjects: PolicySubjects;
  permissions: string[];
  resources: PolicyResources;
  data: PolicyData;
  conditions: PolicyConditions;
  created_at?: string;
  updated_at?: string | null;
  updated_by?: string;
};

export type PermissionInfo = { name: string; description: string; cluster_scoped: boolean };

export type Decision = { allowed: boolean; policy?: string; reason: string };
export type PolicyMatch = { policy: string; effect: string; applies: boolean; why: string };
export type SQLProfile = {
  level: 'none' | 'read' | 'write' | 'admin';
  stats: boolean;
  databases: string[];
  schemas: string[] | null;
  tables: string[] | null;
  hidden_columns: string[];
  max_rows: number;
  timeout_seconds: number;
  policies: string[] | null;
  note?: string;
  /** GET /clusters/{id}/sql/access only: the cluster's databases this user may open */
  available_databases?: string[];
  databases_error?: string;
};
export type SimulateResult = {
  username: string;
  attributes?: Record<string, string>;
  decisions: Record<string, Decision>;
  sql?: SQLProfile;
  policies: PolicyMatch[];
};

export type AuditEvent = {
  id: number;
  at: string;
  user_id?: number;
  username: string;
  client_ip?: string;
  action: string;
  method?: string;
  path?: string;
  cluster_id?: number;
  outcome: 'ok' | 'denied' | 'error';
  status?: number;
  details?: Record<string, unknown>;
};
export type AuditQuery = {
  username?: string;
  action?: string;
  outcome?: string;
  cluster_id?: number;
  from?: string;
  to?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export type LogFiles = {
  server?: string;
  log_directory?: string;
  current?: string;
  files?: { name: string; size: number; modified: string }[];
};
export type LogChunk = { file: string; size: number; offset: number; next: number; text: string; truncated?: boolean };

const clean = <T extends object>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null)) as Partial<T>;

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Policies'] }).injectEndpoints({
  endpoints: (build) => ({
    getPolicies: build.query<Policy[], void>({ query: () => ({ url: '/policies' }), providesTags: ['Policies'] }),
    getPermissionCatalog: build.query<PermissionInfo[], void>({ query: () => ({ url: '/policies/permissions' }) }),
    postPolicy: build.mutation<Policy, Policy>({
      query: (body) => ({ url: '/policies', method: 'POST', body }),
      invalidatesTags: ['Policies'],
    }),
    patchPolicy: build.mutation<Policy, Policy & { id: number }>({
      query: ({ id, ...body }) => ({ url: `/policies/${id}`, method: 'PATCH', body: { id, ...body } }),
      invalidatesTags: ['Policies'],
    }),
    deletePolicy: build.mutation<void, { id: number }>({
      query: ({ id }) => ({ url: `/policies/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Policies'],
    }),
    postSimulate: build.mutation<
      SimulateResult,
      { username: string; cluster_id?: number; database?: string; client_ip?: string; at?: string; policy?: Policy }
    >({
      query: (body) => ({ url: '/policies/simulate', method: 'POST', body: clean(body) }),
    }),
    getAudit: build.query<{ data: AuditEvent[]; total?: number }, AuditQuery>({
      query: (params) => ({ url: '/audit', params: clean(params) }),
    }),
    getSqlAccess: build.query<SQLProfile, { id: number; database?: string }>({
      query: ({ id, database }) => ({ url: `/clusters/${id}/sql/access`, params: clean({ database }) }),
      keepUnusedDataFor: 5,
    }),
    getLogFiles: build.query<LogFiles, { id: number; server_id: number }>({
      query: ({ id, server_id }) => ({ url: `/clusters/${id}/logs`, params: { server_id } }),
    }),
    getLogChunk: build.query<
      LogChunk,
      { id: number; server_id: number; file: string; tail_kb?: number; since?: number }
    >({
      query: ({ id, file, ...params }) => ({
        url: `/clusters/${id}/logs/${encodeURIComponent(file)}`,
        params: clean(params),
      }),
      keepUnusedDataFor: 0,
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as accessApi };
export const {
  useGetPoliciesQuery,
  useGetPermissionCatalogQuery,
  usePostPolicyMutation,
  usePatchPolicyMutation,
  useDeletePolicyMutation,
  usePostSimulateMutation,
  useGetAuditQuery,
  useGetSqlAccessQuery,
  useGetLogFilesQuery,
  useLazyGetLogChunkQuery,
} = injectedRtkApi;
