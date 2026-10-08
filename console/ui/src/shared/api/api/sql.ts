// pg_genin: SQL editor endpoints (see console/service/api/swagger.yaml: /clusters/{id}/sql).
import { baseApi as api } from '../baseApi.ts';

const injectedRtkApi = api.injectEndpoints({
  endpoints: (build) => ({
    postClustersByIdSql: build.mutation<SqlRunResponse, SqlRunArg>({
      query: ({ id, ...body }) => ({ url: `/clusters/${id}/sql`, method: 'POST', body }),
    }),
    postClustersByIdSqlCancel: build.mutation<{ cancelled?: boolean }, { id: number; run_id: string }>({
      query: ({ id, ...body }) => ({ url: `/clusters/${id}/sql/cancel`, method: 'POST', body }),
    }),
  }),
  overrideExisting: false,
});

export { injectedRtkApi as sqlApi };
export const { usePostClustersByIdSqlMutation, usePostClustersByIdSqlCancelMutation } = injectedRtkApi;

export type SqlRunArg = {
  id: number;
  sql: string;
  database?: string;
  max_rows?: number;
  timeout_seconds?: number;
  run_id?: string;
};

export type SqlColumn = { name?: string; type?: string; type_oid?: number };

export type SqlResultSet = {
  statement?: number;
  columns?: SqlColumn[];
  rows?: (string | null)[][];
  row_count?: number;
  truncated?: boolean;
  command_tag?: string;
  duration_ms?: number;
};

export type SqlError = {
  message?: string;
  severity?: string;
  sqlstate?: string;
  detail?: string;
  hint?: string;
  position?: number;
  where?: string;
  statement?: number;
};

export type SqlRunResponse = {
  results?: SqlResultSet[];
  notices?: string[] | null;
  error?: SqlError;
  cancelled?: boolean;
  duration_ms?: number;
  server?: string;
  database?: string;
};
