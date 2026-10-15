// pg_mantra: Backups - pgBackRest of any cluster: live status, backup now, config on every node, schedule, restore.
import { baseApi as api } from '../baseApi.ts';
import { Upgrade, UTarget } from './upgrade.ts';

export type BSSH = { ssh_user?: string; ssh_password?: string; ssh_key?: string; ssh_port?: number };

export type BNodeRaw = {
  ok: boolean;
  error?: string;
  installed?: boolean;
  version?: string;
  config_path?: string;
  config?: string;
  config_files?: { path: string; content: string }[];
  stanza?: string;
  stanzas?: string[];
  remote_repo?: string;
  repo_host?: boolean;
  repos?: { key: string; type: string; path?: string; free_bytes?: number }[];
  timeline?: string;
  cron?: { file: string; line: string; ours: boolean; timer?: boolean }[];
  pg?: {
    running?: boolean;
    role?: 'primary' | 'replica';
    version?: string;
    archive_mode?: string;
    archive_timeout?: string;
    last_archived_wal?: string;
    last_archived_time?: string;
    lsn?: string;
    remote?: string;
  };
  patroni?: { running?: boolean; scope?: string; role?: string } | null;
};
export type BNode = { name: string; address: string; ok: boolean; error?: string; status?: BNodeRaw };
export type BBackup = {
  label: string;
  type: 'full' | 'diff' | 'incr';
  start: string;
  stop: string;
  duration_s: number;
  size: number;
  delta: number;
  repo_size: number;
  repo_delta: number;
  prior?: string | null;
  usable: boolean;
  error?: boolean;
  wal_start?: string;
  wal_stop?: string;
};
export type BIssue = { severity: 'error' | 'warning' | 'info'; text: string };
export type BStatus = {
  need_login?: boolean;
  name: string;
  nodes: BNode[];
  primary: string;
  runner: string;
  stanza: string;
  stanza_status?: { code: number; message: string } | null;
  backups: BBackup[];
  window: {
    from?: string;
    to?: string;
    span_s?: number;
    data_loss_s?: number;
    pending_wal_bytes?: number;
    wal_time_known?: boolean;
    last_backup_age_s?: number;
  };
  repo_bytes: number;
  issues: BIssue[];
  config_diff: { section: string; key: string; kind: 'db' | 'repo'; values: Record<string, string> }[];
  can_create_stanza?: boolean;
  checked_at: string;
};

export type BAction = 'backup' | 'check' | 'stanza-create' | 'config' | 'schedule' | 'restore';
export type BCron = {
  type: 'full' | 'diff' | 'incr';
  minute: string;
  hour: string;
  dom: string;
  month: string;
  dow: string;
};
export type BJobRequest = BSSH & {
  action: BAction;
  stanza?: string;
  type?: string;
  target_time?: string;
  set?: string;
  restore_host?: string;
  pre_backup?: boolean;
  post_backup?: boolean;
  confirm?: string;
  config?: string;
  file?: string;
  config_kind?: 'db' | 'repo';
  keep_local?: boolean;
  verify?: boolean;
  entries?: BCron[];
  remove?: boolean;
};
export type BJob = Omit<Upgrade, 'action' | 'options' | 'result'> & {
  action: BAction;
  options: {
    stanza?: string;
    type?: string;
    target_time?: string;
    set?: string;
    restore_host?: string;
    pre_backup?: boolean;
    post_backup?: boolean;
    entries?: BCron[];
    remove?: boolean;
  } | null;
  result:
    ({ host: string; phase: string; status: string; detail?: Record<string, unknown> } | { error: string })[] | null;
};

const base = (t: UTarget) => `/backups/${t.kind}/${t.id}`;

const injectedRtkApi = api.enhanceEndpoints({ addTagTypes: ['Backups'] }).injectEndpoints({
  endpoints: (build) => ({
    postBackupStatus: build.mutation<BStatus, { target: UTarget; body: BSSH & { stanza?: string } }>({
      query: ({ target, body }) => ({ url: `${base(target)}/status`, method: 'POST', body }),
    }),
    getBackupJobs: build.query<BJob[], UTarget>({
      query: (t) => ({ url: `${base(t)}/jobs` }),
      providesTags: (_r, _e, t) => [{ type: 'Backups', id: `${t.kind}/${t.id}` }],
    }),
    getBackupJob: build.query<BJob, UTarget & { uid: number }>({
      query: (t) => ({ url: `${base(t)}/jobs/${t.uid}` }),
    }),
    postBackupJob: build.mutation<BJob, { target: UTarget; body: BJobRequest }>({
      query: ({ target, body }) => ({ url: `${base(target)}/jobs`, method: 'POST', body }),
      invalidatesTags: (_r, _e, { target }) => [{ type: 'Backups', id: `${target.kind}/${target.id}` }],
    }),
  }),
  overrideExisting: false,
});

export const { usePostBackupStatusMutation, useGetBackupJobsQuery, useGetBackupJobQuery, usePostBackupJobMutation } =
  injectedRtkApi;
