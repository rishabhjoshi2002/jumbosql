// pg_mantra: Custom playbooks - your own upgrade / rollback playbooks, run by the console in the upgrade runner
// container (dry run = ansible-playbook --check --diff).
import { baseApi as api } from '../baseApi.ts';

export type PVarType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'textarea';
export type PVariable = {
  name: string;
  label?: string;
  type: PVarType;
  required?: boolean;
  default?: string | number | boolean | null;
  options?: string[];
  help?: string;
};
export type PGroup = { group: string; from: string };

export type Playbook = {
  id: number;
  name: string;
  description: string;
  playbook: string;
  playbook_path: string;
  rollback: string;
  rollback_path: string;
  requirements: string;
  variables: PVariable[] | null;
  groups: PGroup[] | null;
  files_name: string;
  files_size: number;
  has_rollback: boolean;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type PlaybookRequest = {
  name: string;
  description?: string;
  playbook?: string;
  playbook_path?: string;
  rollback?: string;
  rollback_path?: string;
  requirements?: string;
  variables?: PVariable[];
  groups?: PGroup[];
  files_base64?: string;
  files_name?: string;
  files_keep?: boolean;
};

export type PHostResult = {
  host: string;
  status: 'success' | 'failed';
  changed?: string[] | null;
  stats?: { ok: number; changed: number; failures: number; unreachable: number; skipped: number };
  task?: string;
  error?: string;
  report?: unknown;
};

export type PlaybookRun = {
  id: number;
  playbook_id?: number;
  action: 'plan' | 'run' | 'rollback';
  status: 'running' | 'success' | 'failed';
  parent_id?: number | null;
  options: {
    discovery_id?: number;
    cluster_id?: number;
    inventory?: string;
    hosts?: string[];
    vars?: Record<string, unknown>;
    extra_vars?: string;
    ssh_user?: string;
  } | null;
  result: (PHostResult | { error: string })[] | null;
  log?: string;
  created_by: string;
  created_at: string;
  finished_at?: string | null;
};

export type PlaybookRunRequest = {
  action: 'plan' | 'run' | 'rollback';
  parent_id?: number;
  discovery_id?: number;
  cluster_id?: number;
  inventory?: string;
  hosts?: string[];
  vars?: Record<string, unknown>;
  extra_vars?: string;
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
  ssh_port?: number;
  become_password?: string;
  vault_password?: string;
  verbose?: boolean;
};

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Playbooks', 'PlaybookRuns'] }).injectEndpoints({
  endpoints: (build) => ({
    getPlaybooks: build.query<Playbook[], void>({
      query: () => ({ url: `/custom-playbooks` }),
      providesTags: ['Playbooks'],
    }),
    postPlaybook: build.mutation<Playbook, PlaybookRequest>({
      query: (body) => ({ url: `/custom-playbooks`, method: 'POST', body }),
      invalidatesTags: ['Playbooks'],
    }),
    putPlaybook: build.mutation<Playbook, { id: number; body: PlaybookRequest }>({
      query: ({ id, body }) => ({ url: `/custom-playbooks/${id}`, method: 'PUT', body }),
      invalidatesTags: ['Playbooks'],
    }),
    deletePlaybook: build.mutation<unknown, number>({
      query: (id) => ({ url: `/custom-playbooks/${id}`, method: 'DELETE' }),
      invalidatesTags: ['Playbooks'],
    }),
    getPlaybookRuns: build.query<PlaybookRun[], number>({
      query: (id) => ({ url: `/custom-playbooks/${id}/runs` }),
      providesTags: (_r, _e, id) => [{ type: 'PlaybookRuns', id }],
    }),
    getPlaybookRun: build.query<PlaybookRun, { id: number; uid: number }>({
      query: ({ id, uid }) => ({ url: `/custom-playbooks/${id}/runs/${uid}` }),
    }),
    postPlaybookRun: build.mutation<PlaybookRun, { id: number; body: PlaybookRunRequest }>({
      query: ({ id, body }) => ({ url: `/custom-playbooks/${id}/runs`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { id }) => [{ type: 'PlaybookRuns', id }],
    }),
  }),
  overrideExisting: false,
});

export const {
  useGetPlaybooksQuery,
  usePostPlaybookMutation,
  usePutPlaybookMutation,
  useDeletePlaybookMutation,
  useGetPlaybookRunsQuery,
  useGetPlaybookRunQuery,
  usePostPlaybookRunMutation,
} = injectedRtkApi;
