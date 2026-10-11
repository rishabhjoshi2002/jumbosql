// pg_mantra: Upgrades - plan (dry run), run and roll back package upgrades of a cluster's components.
import { baseApi as api } from '../baseApi.ts';

export type UComponent = {
  name: string;
  label: string;
  groups: string[];
  order: 'replicas_first' | 'one_by_one';
  restart: string;
  notes: string[] | null;
};

export type UPackage = { name: string; installed: string; candidate: string; versions?: string[]; arch?: string };
export type UDetect = {
  ok: boolean;
  error?: string;
  warnings?: string[];
  family?: string;
  pm?: string;
  method?: 'package' | 'pip' | 'binary' | 'none';
  packages?: UPackage[];
  pip?: { name: string; installed: string; candidate: string; versions?: string[] } | null;
  binary?: { files: { path: string; version: string }[]; installed: string; candidate: string; url?: string } | null;
  services?: { name: string; active: boolean; enabled: string }[];
  patroni?: { role?: string; state?: string; member?: string; scope?: string; version?: string } | null;
  free_bytes?: number;
  to_upgrade?: string[];
  pg_majors?: string[];
};
export type UStep = {
  ok?: boolean;
  error?: string;
  warnings?: string[];
  before?: Record<string, string>;
  after?: Record<string, string>;
};
export type UHostResult = {
  host: string;
  phase: 'plan' | 'run' | 'rollback';
  status?: 'success' | 'failed' | 'skipped';
  reason?: string;
  error?: string;
  task?: string;
  detect?: UDetect;
  preserve?:
    | (UStep & {
        dir?: string;
        saved?: { name: string; version: string; files: string[] }[];
        unsaved?: { name: string; version: string }[];
        configs?: string[];
      })
    | null;
  change?: UStep | null;
  restart?: (UStep & { restarted?: string[] }) | null;
  health?: UStep | null;
  switchover?: UStep | null;
};
export type Upgrade = {
  id: number;
  cluster_id: number;
  component: string;
  action: 'plan' | 'run' | 'rollback';
  status: 'running' | 'success' | 'failed';
  parent_id?: number | null;
  operation_id?: number | null;
  options: {
    target?: string;
    allow_unsaved?: boolean;
    restore_config?: boolean;
    binary_url?: string;
    hosts?: string[];
  } | null;
  result: (UHostResult | { error: string })[] | null;
  created_by: string;
  created_at: string;
  finished_at?: string | null;
};
export type UpgradeRequest = {
  component: string;
  action: 'plan' | 'run' | 'rollback';
  parent_id?: number;
  target?: string;
  allow_unsaved?: boolean;
  restore_config?: boolean;
  binary_url?: string;
  hosts?: string[];
  ssh_user?: string;
  ssh_password?: string;
  ssh_key?: string;
};

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Upgrades'] }).injectEndpoints({
  endpoints: (build) => ({
    getUpgradeComponents: build.query<UComponent[], void>({ query: () => ({ url: `/upgrade/components` }) }),
    getUpgrades: build.query<Upgrade[], number>({
      query: (clusterId) => ({ url: `/clusters/${clusterId}/upgrades` }),
      providesTags: (_r, _e, id) => [{ type: 'Upgrades', id }],
    }),
    postUpgrade: build.mutation<Upgrade, { clusterId: number; body: UpgradeRequest }>({
      query: ({ clusterId, body }) => ({ url: `/clusters/${clusterId}/upgrades`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { clusterId }) => [{ type: 'Upgrades', id: clusterId }],
    }),
  }),
  overrideExisting: false,
});

export const { useGetUpgradeComponentsQuery, useGetUpgradesQuery, usePostUpgradeMutation } = injectedRtkApi;
