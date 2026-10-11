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
  cluster_id?: number | null;
  discovery_id?: number | null;
  log?: string;
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
    repo?: { url: string; only?: boolean; gpgcheck?: boolean; gpgkey?: string } | null;
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
  ssh_port?: number;
  repo_url?: string;
  repo_only?: boolean;
  repo_gpgcheck?: boolean;
  repo_gpgkey?: string;
};

/** where an upgrade runs: a setup found by Discover (a saved discovery) or a cluster of the console */
export type UTarget = { kind: 'discoveries' | 'clusters'; id: number };
const base = (t: UTarget) => `/${t.kind}/${t.id}/upgrades`;

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Upgrades'] }).injectEndpoints({
  endpoints: (build) => ({
    getUpgradeComponents: build.query<UComponent[], void>({ query: () => ({ url: `/upgrade/components` }) }),
    getUpgrades: build.query<Upgrade[], UTarget>({
      query: (t) => ({ url: base(t) }),
      providesTags: (_r, _e, t) => [{ type: 'Upgrades', id: `${t.kind}/${t.id}` }],
    }),
    getUpgrade: build.query<Upgrade, UTarget & { uid: number }>({
      query: (t) => ({ url: `${base(t)}/${t.uid}` }),
    }),
    postUpgrade: build.mutation<Upgrade, { target: UTarget; body: UpgradeRequest }>({
      query: ({ target, body }) => ({ url: base(target), method: 'POST', body }),
      invalidatesTags: (_r, _e, { target }) => [{ type: 'Upgrades', id: `${target.kind}/${target.id}` }],
    }),
  }),
  overrideExisting: false,
});

export const { useGetUpgradeComponentsQuery, useGetUpgradesQuery, useGetUpgradeQuery, usePostUpgradeMutation } =
  injectedRtkApi;
