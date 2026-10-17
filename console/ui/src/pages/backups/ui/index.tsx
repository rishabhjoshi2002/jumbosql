import { FC, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import BackupIcon from '@mui/icons-material/Backup';
import RestoreIcon from '@mui/icons-material/SettingsBackupRestore';
import FactCheckIcon from '@mui/icons-material/FactCheckOutlined';
import SaveIcon from '@mui/icons-material/Save';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useSearchParams } from 'react-router-dom';
import {
  BAction,
  BBackup,
  BCron,
  BJob,
  BJobRequest,
  BStatus,
  useGetBackupActivityQuery,
  useGetBackupJobQuery,
  useGetBackupJobsQuery,
  usePostBackupJobMutation,
  usePostBackupStatusMutation,
} from '@shared/api/api/backup.ts';
import { UTarget } from '@shared/api/api/upgrade.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import Card from '@pages/discover/ui/Card.tsx';
import TargetSelect, { targetKey } from '@pages/upgrade/ui/TargetSelect.tsx';
import RunView from '@pages/upgrade/ui/RunView.tsx';
import { apiErrorText } from '@shared/lib/apiError.ts';
import Timeline, { when } from './Timeline.tsx';
import BackupFlow, { FlowNode } from './BackupFlow.tsx';
import { RepoCards, RepoPick, Running, RunningNow, repoName } from './Repos.tsx';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };
const STATUS = { running: 'info', success: 'success', failed: 'error' } as const;

/** what a job did, in words: "Point In Time · 2026-10-14 05:34:01+00", "Full" ... */
const jobKind = (j: BJob, t: (k: string) => string) =>
  j.action === 'restore'
    ? j.options?.set
      ? `${t('r_set')} · ${j.options.set}`
      : j.options?.target_time
        ? `${t('r_time')} · ${j.options.target_time}`
        : t('r_latest')
    : j.action === 'backup' && j.options?.type
      ? `${t(j.options.type)}${j.options.repo ? ` · ${t('rp_repo')} ${j.options.repo}` : ''}`
      : j.action === 'repo-add'
        ? `${t('rp_repo')} ${j.options?.index ?? ''} · ${t(`rp_t_${j.options?.repo_type ?? 'posix'}`)} ${j.options?.repo_where ?? ''}`
        : j.action === 'repo-remove'
          ? `${t('rp_repo')} ${j.options?.index ?? ''}`
          : '';

export const ago = (s?: number) => {
  if (s === undefined || s === null || !Number.isFinite(s)) return '—';
  const a = Math.max(0, s);
  if (a < 90) return `${Math.round(a)}s`;
  if (a < 5400) return `${Math.round(a / 60)} min`;
  if (a < 172800) return `${(a / 3600).toFixed(a < 36000 ? 1 : 0)} h`;
  return `${Math.round(a / 86400)} days`;
};

/** the playbook's task names -> the steps shown on each node */
const STEP: Record<string, string> = {
  Status: 'look',
  'Read it': 'look',
  'Back up': 'backup',
  Check: 'bcheck',
  'Create the stanza': 'stanza',
  'Write the config': 'write',
  'Write the repository': 'repowrite',
  'Check the new config': 'verify',
  'Put the old config back': 'undo',
  'Write the schedule': 'schedule',
  'Back up first': 'prebackup',
  Stop: 'stop',
  Restore: 'restore',
  'Restore standby': 'restore',
  'Recover and promote': 'promote',
  'Recreate the replication slots': 'slots',
  Start: 'start',
  'Full backup after the restore': 'postbackup',
};
const STEPS: Record<BAction, string[]> = {
  backup: ['look', 'backup'],
  check: ['look', 'bcheck'],
  'stanza-create': ['look', 'stanza'],
  config: ['look', 'write', 'verify'],
  schedule: ['look', 'schedule'],
  restore: ['look', 'prebackup', 'stop', 'restore', 'promote', 'start', 'postbackup'],
  'repo-add': ['look', 'repowrite', 'verify'],
  'repo-remove': ['look', 'repowrite'],
};
const stepOf = (task: string) => STEP[task];

/** "2026-10-14T10:20:30" (local, from the input) -> "2026-10-14 10:20:30+05:30" for PostgreSQL */
const withZone = (local: string) => {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  const off = -d.getTimezoneOffset();
  const p = (n: number) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const s = local.length === 16 ? `${local}:00` : local;
  return `${s.replace('T', ' ')}${off >= 0 ? '+' : '-'}${p(off / 60)}:${p(off % 60)}`;
};
const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const DEFAULT_CRON: (BCron & { on: boolean; repo?: string })[] = [
  { on: true, type: 'full', minute: '0', hour: '1', dom: '*', month: '*', dow: '0' },
  { on: true, type: 'diff', minute: '0', hour: '1', dom: '*', month: '*', dow: '1-6' },
  { on: false, type: 'incr', minute: '0', hour: '*/4', dom: '*', month: '*', dow: '*' },
];
/** read our own cron lines back into the form */
const cronFrom = (lines: string[]) => {
  const out = DEFAULT_CRON.map((c) => ({ ...c, on: false }));
  let any = false;
  lines.forEach((l) => {
    const f = l.trim().split(/\s+/);
    const tm = /--type=(full|diff|incr)/.exec(l)?.[1];
    const i = out.findIndex((c) => c.type === tm);
    if (f.length > 5 && i >= 0) {
      out[i] = {
        on: true,
        type: out[i].type,
        minute: f[0],
        hour: f[1],
        dom: f[2],
        month: f[3],
        dow: f[4],
        repo: /--repo=(\d+)/.exec(l)?.[1] ?? '',
      };
      any = true;
    }
  });
  return any ? out : DEFAULT_CRON;
};

const Stat: FC<{ label: string; value: ReactNode; sub?: ReactNode; tone?: 'error' | 'warning' | 'success' }> = ({
  label,
  value,
  sub,
  tone,
}) => (
  <Box
    sx={{
      border: 1,
      borderColor: tone ? `${tone}.main` : 'divider',
      borderLeftWidth: 4,
      borderRadius: 2,
      p: 1.5,
      bgcolor: 'background.paper',
      minWidth: 0,
    }}>
    <Typography variant="caption" color="text.secondary" fontWeight={700}>
      {label}
    </Typography>
    <Typography variant="h6" fontWeight={800} noWrap>
      {value}
    </Typography>
    {sub ? (
      <Typography variant="caption" color="text.secondary" display="block" noWrap>
        {sub}
      </Typography>
    ) : null}
  </Box>
);

/** pg_mantra Backups: pgBackRest of any cluster - created by pg_mantra or found by Discover. */
const Backups: FC = () => {
  const { t } = useTranslation('backup');
  const [params] = useSearchParams();
  const [target, setTarget] = useState<UTarget | null>(() => {
    const d = Number(params.get('discovery'));
    const c = Number(params.get('cluster'));
    return d ? { kind: 'discoveries', id: d } : c ? { kind: 'clusters', id: c } : null;
  });
  const [ssh, setSsh] = useState({ ssh_user: '', ssh_password: '', ssh_key: '', ssh_port: '' });
  const [stanza, setStanza] = useState('');
  const [status, setStatus] = useState<BStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [tab, setTab] = useState(0);
  const [view, setView] = useState<'status' | 'run'>('status');
  const [selected, setSelected] = useState(0);
  const [live, setLive] = useState(params.get('live') === '1');
  const [getStatus, loading] = usePostBackupStatusMutation();
  const [post, posting] = usePostBackupJobMutation();

  const login = useMemo(
    () => ({
      ...(ssh.ssh_user.trim() ? { ssh_user: ssh.ssh_user.trim(), ssh_password: ssh.ssh_password } : {}),
      ...(ssh.ssh_user.trim() && ssh.ssh_key.trim() ? { ssh_key: ssh.ssh_key } : {}),
      ...(Number(ssh.ssh_port) ? { ssh_port: Number(ssh.ssh_port) } : {}),
    }),
    [ssh],
  );
  const needLogin = target?.kind === 'discoveries' && !ssh.ssh_user.trim();

  const load = useCallback(async () => {
    if (!target?.id || needLogin) return;
    setStatusError('');
    try {
      const res = await getStatus({ target, body: { ...login, stanza: stanza.trim() || undefined } }).unwrap();
      if (res.need_login) {
        setStatus(null);
        setStatusError('give the SSH');
        return;
      }
      setStatus(res);
    } catch (e) {
      setStatus(null);
      setStatusError(apiErrorText(e));
    }
  }, [target, needLogin, getStatus, login, stanza]);

  const onTarget = useCallback((v: UTarget | null) => {
    setTarget(v);
    setStatus(null);
    setStatusError('');
    setView('status');
    setSelected(0);
  }, []);
  // opened again from a popup (?cluster=..&live=1) while already here: follow it
  useEffect(() => {
    const d = Number(params.get('discovery'));
    const c = Number(params.get('cluster'));
    const want: UTarget | null = d ? { kind: 'discoveries', id: d } : c ? { kind: 'clusters', id: c } : null;
    if (want && targetKey(want) !== targetKey(target)) onTarget(want);
    if (params.get('live') === '1') {
      setLive(true);
      setView('status');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);
  // a cluster of the console has its SSH secret: read it at once
  useEffect(() => {
    if (target?.kind === 'clusters' && !status && !loading.isLoading && !statusError) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey(target)]);

  const jobs = useGetBackupJobsQuery(target ?? { kind: 'discoveries', id: 0 }, { skip: !target?.id });
  const running = (jobs.data ?? []).some((j) => j.status === 'running');
  useGetBackupJobsQuery(target ?? { kind: 'discoveries', id: 0 }, {
    skip: !target?.id || !running,
    pollingInterval: 3000,
  });
  useEffect(() => {
    const r = (jobs.data ?? []).find((j) => j.status === 'running');
    if (r && view === 'status') {
      setSelected(r.id);
      setView('run');
    }
  }, [jobs.data, view]);
  // backups running now that the console did not start (a schedule, or someone on a node): shown live
  const activity = useGetBackupActivityQuery(
    { fresh: live },
    { skip: !target?.id, pollingInterval: live ? 5000 : 30000, refetchOnMountOrArgChange: true },
  );
  const runningNow: Running[] = useMemo(() => {
    if (!target) return [];
    const fromWatch = (activity.data?.items ?? [])
      .filter((a) => a.kind === target.kind && a.id === target.id && a.by !== 'console')
      .map((a) => ({ ...a, started: new Date(a.started).getTime() / 1000 }));
    if (fromWatch.length || activity.data) return fromWatch;
    // before the first answer: what the status saw
    return (status?.nodes ?? []).flatMap((n) =>
      (n.status?.running ?? [])
        .filter((r) => r.by !== 'console')
        .map((r) => ({ ...r, key: `${n.address}/${r.pid}/${r.started}`, node: n.address })),
    );
  }, [activity.data, status, target]);
  useEffect(() => {
    if (runningNow.length && !live) setLive(true);
  }, [runningNow.length, live]);
  // a running backup ended: read the status again (the new backup is in it)
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (runningNow.length) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      setLive(false);
      toast.success(t('rn_finished'));
      void load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningNow.length]);
  const current: BJob | undefined = (jobs.data ?? []).find((j) => j.id === selected);
  const detail = useGetBackupJobQuery(
    { ...(target ?? { kind: 'discoveries', id: 0 }), uid: selected },
    { skip: !selected || !target, pollingInterval: current?.status === 'running' ? 2000 : 0 },
  );
  // when a job ends, read the status again
  const [lastDone, setLastDone] = useState(0);
  useEffect(() => {
    if (current && current.status !== 'running' && current.id !== lastDone && view === 'run') {
      setLastDone(current.id);
      void load();
    }
  }, [current, lastDone, view, load]);

  const start = async (body: BJobRequest) => {
    if (!target) return;
    try {
      const st = stanza.trim() || status?.stanza || undefined;
      const j = await post({ target, body: { ...login, stanza: st, ...body } }).unwrap();
      toast.success(t('jobStarted', { id: j.id }));
      setSelected(j.id);
      setView('run');
    } catch (e) {
      toast.error(apiErrorText(e));
    }
  };

  const roles = useMemo(() => {
    const m: Record<string, string> = {};
    (status?.nodes ?? []).forEach((n) => {
      const r = n.status?.repo_host
        ? t('repoHost')
        : n.status?.pg?.role === 'primary'
          ? t('primary')
          : n.status?.pg?.role === 'replica'
            ? t('replica')
            : t('down');
      m[n.name] = r;
      m[n.address] = r;
    });
    return m;
  }, [status, t]);

  // the nodes and the repository, for the live picture of a job
  const flowNodes: FlowNode[] = (status?.nodes ?? []).map((n) => ({
    name: n.name,
    address: n.address,
    role: n.status?.repo_host
      ? 'repo'
      : n.status?.pg?.role === 'primary'
        ? 'primary'
        : n.status?.pg?.role === 'replica'
          ? 'replica'
          : n.ok
            ? 'down'
            : '',
  }));
  const repoNode = status?.nodes.find((n) => n.status?.repo_host);
  const runnerNode = status?.nodes.find((n) => n.address === status.runner);
  const flowRepo = {
    host: repoNode?.address,
    path: (repoNode ?? runnerNode)?.status?.repos?.find((r) => r.path)?.path,
  };

  if (view === 'run' && current && target) {
    const restored = (current.result ?? []).find(
      (r) => isStep(r) && r.phase === 'restore' && (r.detail as { set?: string } | undefined)?.set,
    ) as { detail?: { set?: string } } | undefined;
    return (
      <RunView
        title={`#${current.id} · ${t(`a_${current.action}`)}${jobKind(current, t) ? ` · ${jobKind(current, t)}` : ''}`}
        status={current.status}
        log={detail.data?.id === current.id ? (detail.data?.log ?? '') : ''}
        knownHosts={status?.nodes.map((n) => n.name)}
        steps={STEPS[current.action]}
        stepOf={stepOf}
        roles={roles}
        picture={(prog, isRunning) => (
          <BackupFlow
            action={current.action}
            p={prog}
            running={isRunning}
            failed={current.status === 'failed'}
            nodes={flowNodes}
            repo={flowRepo}
            steps={STEPS[current.action]}
            stepOf={stepOf}
            result={current.result}
            startedAt={current.created_at}
            finishedAt={current.finished_at}
          />
        )}
        onBack={() => setView('status')}
        actions={
          current.status !== 'running' ? (
            <Button variant="contained" startIcon={<RefreshIcon />} onClick={() => setView('status')}>
              {t('backToStatus')}
            </Button>
          ) : null
        }>
        {restored?.detail?.set ? (
          <Alert severity="success">{t('restoredSet', { set: restored.detail.set })}</Alert>
        ) : null}
        <JobResult job={current} />
      </RunView>
    );
  }

  return (
    <Stack gap={2}>
      <Card>
        <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="flex-start">
          <Box sx={{ minWidth: 260 }}>
            <TargetSelect value={target} onChange={onTarget} perm="backup.run" />
          </Box>
          <TextField
            size="small"
            label={t('sshUser')}
            value={ssh.ssh_user}
            onChange={(e) => setSsh({ ...ssh, ssh_user: e.target.value })}
            helperText={target?.kind === 'clusters' ? t('sshStored') : t('sshHint')}
            sx={{ width: 200 }}
          />
          <TextField
            size="small"
            type="password"
            label={t('sshPassword')}
            value={ssh.ssh_password}
            onChange={(e) => setSsh({ ...ssh, ssh_password: e.target.value })}
            sx={{ width: 180 }}
          />
          <TextField
            size="small"
            label={t('sshPort')}
            value={ssh.ssh_port}
            placeholder="22"
            onChange={(e) => setSsh({ ...ssh, ssh_port: e.target.value.replace(/\D/g, '') })}
            sx={{ width: 90 }}
          />
          <TextField
            size="small"
            label={t('stanza')}
            value={stanza}
            placeholder={t('stanzaAuto')}
            onChange={(e) => setStanza(e.target.value)}
            sx={{ width: 120 }}
          />
          <Button
            variant="contained"
            startIcon={loading.isLoading ? <CircularProgress size={16} color="inherit" /> : <RefreshIcon />}
            disabled={!target?.id || needLogin || loading.isLoading}
            onClick={() => void load()}
            sx={{ height: 40 }}>
            {status ? t('refresh') : t('load')}
          </Button>
        </Stack>
        <TextField
          size="small"
          fullWidth
          multiline
          minRows={1}
          maxRows={4}
          label={t('sshKey')}
          value={ssh.ssh_key}
          onChange={(e) => setSsh({ ...ssh, ssh_key: e.target.value })}
          sx={{ mt: 1.5, '& textarea': mono }}
        />
      </Card>

      {loading.isLoading ? <Alert severity="info">{t('loading')}</Alert> : null}
      {needLogin && !status ? <Alert severity="info">{t('needLogin')}</Alert> : null}
      {statusError ? (
        // no saved SSH secret for this cluster yet: a hint, not an error
        <Alert severity={statusError.startsWith('give the SSH') ? 'info' : 'error'}>
          {statusError.startsWith('give the SSH') ? t('needLogin') : statusError}
        </Alert>
      ) : null}
      {running && view === 'status' ? <Alert severity="info">{t('busy')}</Alert> : null}

      <RunningNow items={runningNow} status={status} />

      {status ? (
        <StatusView
          status={status}
          tab={tab}
          setTab={setTab}
          busy={running || posting.isLoading}
          start={start}
          jobs={jobs.data ?? []}
          openJob={(id) => {
            setSelected(id);
            setView('run');
          }}
          roles={roles}
        />
      ) : !loading.isLoading && (jobs.data ?? []).length ? (
        <Card title={t('t_history')}>
          <History
            jobs={jobs.data ?? []}
            openJob={(id) => {
              setSelected(id);
              setView('run');
            }}
          />
        </Card>
      ) : null}
    </Stack>
  );
};

/* ------------------------------------------------------------ status */

const StatusView: FC<{
  status: BStatus;
  tab: number;
  setTab: (n: number) => void;
  busy: boolean;
  start: (b: BJobRequest) => Promise<void>;
  jobs: BJob[];
  openJob: (id: number) => void;
  roles: Record<string, string>;
}> = ({ status, tab, setTab, busy, start, jobs, openJob, roles }) => {
  const { t } = useTranslation('backup');
  const w = status.window;
  const usable = status.backups.filter((b) => b.usable);
  const last = [...status.backups].sort((a, b) => b.stop.localeCompare(a.stop))[0];
  const runner = status.nodes.find((n) => n.address === status.runner);
  const free = runner?.status?.repos?.find((r) => r.free_bytes !== undefined)?.free_bytes;
  const [restoreSet, setRestoreSet] = useState<string>('');
  const risk = w.pending_wal_bytes;

  return (
    <Stack gap={2}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(5, minmax(0,1fr))' } }}>
        <Stat
          label={t('c_window')}
          value={w.span_s ? ago(w.span_s) : t('none')}
          sub={w.from ? t('c_windowSub', { from: when(w.from), to: when(w.to) }) : undefined}
          tone={w.span_s ? 'success' : 'error'}
        />
        <Stat
          label={t('c_last')}
          value={last ? when(last.stop) : t('none')}
          sub={last ? t('c_lastSub', { type: t(last.type), age: ago(w.last_backup_age_s) }) : undefined}
          tone={!last ? 'error' : (w.last_backup_age_s ?? 0) > 26 * 3600 ? 'warning' : 'success'}
        />
        <Stat
          label={t('c_risk')}
          value={risk === undefined || risk === null ? t('unknown') : bytes(risk)}
          sub={
            risk === undefined || risk === null
              ? t('c_riskUnknown', { age: ago(w.data_loss_s) })
              : w.wal_time_known === false
                ? t('c_riskSubNoTime')
                : t('c_riskSub', { age: ago(w.data_loss_s) })
          }
          tone={risk !== undefined && risk !== null && risk > 64 * 1024 * 1024 ? 'warning' : undefined}
        />
        <Stat
          label={t('c_count')}
          value={`${usable.length} / ${status.backups.length}`}
          sub={t('c_countSub', { size: bytes(status.repo_bytes) })}
        />
        <Stat
          label={t('c_free')}
          value={free !== undefined ? bytes(free) : '—'}
          sub={`${status.stanza || '—'} · ${status.runner || '—'}`}
        />
      </Box>

      <Card title={t('rp_title')} subtitle={t('rp_help')}>
        <RepoCards status={status} busy={busy} start={start} />
      </Card>

      {status.can_create_stanza ? (
        <Alert
          severity="error"
          action={
            <Button
              color="inherit"
              variant="outlined"
              size="small"
              disabled={busy}
              onClick={() => void start({ action: 'stanza-create' })}>
              {t('stanzaCreate')}
            </Button>
          }>
          {t('stanzaMissing', { stanza: status.stanza })}
        </Alert>
      ) : null}
      {status.issues.map((i, n) => (
        <Alert key={n} severity={i.severity} sx={{ py: 0 }}>
          {i.text}
        </Alert>
      ))}

      <Card title={t('timeline')} subtitle={t('checkedAt', { time: when(status.checked_at) })}>
        <Timeline
          status={status}
          onPick={(b) => {
            setRestoreSet(b.label);
            setTab(1);
          }}
        />
      </Card>

      <Box sx={{ borderBottom: 1, borderColor: 'divider' }}>
        <Tabs value={tab} onChange={(_e, v: number) => setTab(v)} variant="scrollable">
          {['t_backups', 't_restore', 't_config', 't_schedule', 't_nodes', 't_history'].map((k) => (
            <Tab key={k} label={t(k)} sx={{ textTransform: 'none', fontWeight: 700 }} />
          ))}
        </Tabs>
      </Box>
      {tab === 0 ? (
        <BackupsTab
          status={status}
          busy={busy}
          start={start}
          onRestore={(b) => {
            setRestoreSet(b.label);
            setTab(1);
          }}
        />
      ) : null}
      {tab === 1 ? (
        <RestoreTab status={status} busy={busy} start={start} set={restoreSet} setSet={setRestoreSet} />
      ) : null}
      {tab === 2 ? <ConfigTab status={status} busy={busy} start={start} /> : null}
      {tab === 3 ? <ScheduleTab status={status} busy={busy} start={start} /> : null}
      {tab === 4 ? <NodesTab status={status} roles={roles} /> : null}
      {tab === 5 ? (
        <Card>
          <History jobs={jobs} openJob={openJob} />
        </Card>
      ) : null}
    </Stack>
  );
};

/* ------------------------------------------------------------ tabs */

type TabProps = { status: BStatus; busy: boolean; start: (b: BJobRequest) => Promise<void> };

const BackupsTab: FC<TabProps & { onRestore: (b: BBackup) => void }> = ({ status, busy, start, onRestore }) => {
  const { t } = useTranslation('backup');
  const noStanza = !!status.can_create_stanza || !status.stanza;
  const list = [...status.backups].reverse();
  const [repo, setRepo] = useState('');
  const multi = (status.repos ?? []).length > 1;
  const repoLabel = (n?: number) => {
    const r = (status.repos ?? []).find((x) => x.index === (n ?? 1));
    return r ? repoName(r, t) : `${t('rp_repo')} ${n ?? 1}`;
  };
  return (
    <Card
      title={t('t_backups')}
      action={
        <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
          <RepoPick status={status} value={repo} onChange={setRepo} label={t('rp_to')} auto={t('rp_autoBackup')} width={190} />
          {(['full', 'diff', 'incr'] as const).map((k) => (
            <Button
              key={k}
              size="small"
              variant={k === 'full' ? 'contained' : 'outlined'}
              startIcon={<BackupIcon />}
              disabled={busy || noStanza}
              onClick={() => void start({ action: 'backup', type: k, repo: repo || undefined })}>
              {t(k)}
            </Button>
          ))}
          <Button
            size="small"
            startIcon={<FactCheckIcon />}
            disabled={busy}
            onClick={() => void start({ action: 'check' })}>
            {t('check')}
          </Button>
          {status.can_create_stanza ? (
            <Button
              size="small"
              variant="contained"
              disabled={busy}
              onClick={() => void start({ action: 'stanza-create' })}>
              {t('stanzaCreate')}
            </Button>
          ) : null}
        </Stack>
      }>
      {list.length ? (
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                {['label', 'type', ...(multi ? ['rp_repo'] : []), 'started', 'duration', 'size', 'repoSize', 'state', ''].map((k) => (
                  <TableCell key={k} sx={{ fontWeight: 700 }}>
                    {k ? t(k) : ''}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {list.map((b) => (
                <TableRow key={b.label} hover>
                  <TableCell sx={mono}>{b.label}</TableCell>
                  <TableCell>{t(b.type)}</TableCell>
                  {multi ? <TableCell>{repoLabel(b.repo)}</TableCell> : null}
                  <TableCell>{when(b.start)}</TableCell>
                  <TableCell>{ago(b.duration_s)}</TableCell>
                  <TableCell>{bytes(b.size)}</TableCell>
                  <TableCell>{bytes(b.repo_delta)}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      color={b.usable && !b.error ? 'success' : 'default'}
                      label={b.usable ? t('usable') : t('notUsable')}
                    />
                  </TableCell>
                  <TableCell align="right">
                    <Button size="small" disabled={!b.usable || busy} onClick={() => onRestore(b)}>
                      {t('restoreThis')}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <Typography color="text.secondary">{t('noBackups')}</Typography>
      )}
    </Card>
  );
};

const RestoreTab: FC<TabProps & { set: string; setSet: (s: string) => void }> = ({
  status,
  busy,
  start,
  set,
  setSet,
}) => {
  const { t } = useTranslation('backup');
  const [mode, setMode] = useState<'latest' | 'time' | 'set'>(set ? 'set' : 'latest');
  useEffect(() => {
    if (set) setMode('set');
  }, [set]);
  const [time, setTime] = useState(() => toLocalInput(status.window.to));
  const [host, setHost] = useState('');
  const [repo, setRepo] = useState('');
  const [pre, setPre] = useState(false);
  const [postB, setPostB] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState('');
  const usable = status.backups.filter((b) => b.usable && (!repo || String(b.repo ?? 1) === repo));
  const ms = new Date(time).getTime();
  const outside =
    mode === 'time' &&
    !!status.window.from &&
    (ms < new Date(status.window.from).getTime() || ms > new Date(status.window.to ?? status.checked_at).getTime());
  const ready = mode === 'latest' || (mode === 'time' && time && !outside) || (mode === 'set' && set);

  const go = async () => {
    setConfirm(false);
    await start({
      action: 'restore',
      type: mode,
      target_time: mode === 'time' ? withZone(time) : undefined,
      set: mode === 'set' ? set : undefined,
      restore_host: host || undefined,
      repo: repo || undefined,
      pre_backup: pre,
      post_backup: postB,
      confirm: name,
    });
    setName('');
  };

  return (
    <Card title={t('t_restore')}>
      <Stack gap={2} maxWidth={760}>
        <RadioGroup value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          {(['latest', 'time', 'set'] as const).map((m) => (
            <FormControlLabel
              key={m}
              value={m}
              control={<Radio />}
              label={
                <Box>
                  <Typography fontWeight={700}>{t(`r_${m}`)}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t(`r_${m}Help`)}
                  </Typography>
                </Box>
              }
              sx={{ mb: 0.5 }}
            />
          ))}
        </RadioGroup>
        {mode === 'time' ? (
          <TextField
            type="datetime-local"
            size="small"
            label={t('r_targetTime')}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            inputProps={{ step: 1, min: toLocalInput(status.window.from), max: toLocalInput(status.window.to) }}
            InputLabelProps={{ shrink: true }}
            error={outside}
            helperText={
              outside
                ? t('r_outside', { from: when(status.window.from), to: when(status.window.to) })
                : `${when(status.window.from)} → ${when(status.window.to)}`
            }
            sx={{ maxWidth: 320 }}
          />
        ) : null}
        {mode === 'set' ? (
          <TextField
            select
            size="small"
            label={t('r_set')}
            value={set}
            onChange={(e) => setSet(e.target.value)}
            sx={{ maxWidth: 420 }}>
            {usable.map((b) => (
              <MenuItem key={b.label} value={b.label} sx={mono}>
                {b.label} · {t(b.type)} · {when(b.stop)}
                {(status.repos ?? []).length > 1 ? ` · ${t('rp_repo')} ${b.repo ?? 1}` : ''}
              </MenuItem>
            ))}
          </TextField>
        ) : null}
        <RepoPick status={status} value={repo} onChange={setRepo} label={t('rp_from')} auto={t('rp_autoRestore')} width={420} />
        <TextField
          select
          size="small"
          label={t('r_host')}
          value={host}
          onChange={(e) => setHost(e.target.value)}
          sx={{ maxWidth: 420 }}>
          <MenuItem value="">{t('r_hostAuto')}</MenuItem>
          {status.nodes
            .filter((n) => !n.status?.repo_host)
            .map((n) => (
              <MenuItem key={n.name} value={n.name}>
                {n.address}
              </MenuItem>
            ))}
        </TextField>
        <Stack>
          <FormControlLabel
            control={<Checkbox checked={pre} onChange={(e) => setPre(e.target.checked)} />}
            label={t('r_pre')}
          />
          <FormControlLabel
            control={<Checkbox checked={postB} onChange={(e) => setPostB(e.target.checked)} />}
            label={t('r_post')}
          />
        </Stack>
        <Alert severity="warning">{t('r_warn')}</Alert>
        <Box>
          <Button
            variant="contained"
            color="error"
            startIcon={<RestoreIcon />}
            disabled={busy || !ready || !usable.length}
            onClick={() => setConfirm(true)}>
            {t('r_start')}
          </Button>
        </Box>
      </Stack>
      <Dialog open={confirm} onClose={() => setConfirm(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('r_confirmTitle', { name: status.name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" mb={2}>
            {t('r_confirm')}
          </Typography>
          <Typography variant="body2" fontWeight={700} mb={2} sx={mono}>
            {mode === 'latest' ? t('r_latest') : mode === 'time' ? withZone(time) : set}
          </Typography>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label={t('r_name')}
            placeholder={status.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(false)}>{t('cancel', { ns: 'upgrade' })}</Button>
          <Button color="error" variant="contained" disabled={name.trim() !== status.name} onClick={() => void go()}>
            {t('t_restore')}
          </Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
};

const kindOf = (n: BStatus['nodes'][number]) => (n.status?.repo_host ? 'repo' : 'db') as 'db' | 'repo';
const base = (p: string) => p.split('/').pop() ?? p;

const ConfigTab: FC<TabProps> = ({ status, busy, start }) => {
  const { t } = useTranslation('backup');
  const nodes = status.nodes.filter((n) => n.ok && n.status?.installed);
  const [from, setFrom] = useState(nodes.find((n) => n.address === status.primary)?.name ?? nodes[0]?.name ?? '');
  const node = nodes.find((n) => n.name === from);
  const files = useMemo(
    () =>
      node?.status?.config_files?.length
        ? node.status.config_files
        : [{ path: node?.status?.config_path ?? 'pgbackrest.conf', content: node?.status?.config ?? '' }],
    [node],
  );
  const [file, setFile] = useState('');
  useEffect(() => setFile(files[0]?.path ?? ''), [files]);
  const original = files.find((f) => f.path === file)?.content ?? '';
  const [text, setText] = useState(original);
  useEffect(() => setText(original), [original]);
  const [keepLocal, setKeepLocal] = useState(true);
  const [verify, setVerify] = useState(true);
  const kind = node ? kindOf(node) : 'db';
  const same = nodes.filter((n) => kindOf(n) === kind);
  const kinds = new Set(nodes.map(kindOf));
  const nodeAddrs = nodes.map((n) => n.address);

  return (
    <Stack gap={2}>
      <Card
        title={t('t_config')}
        subtitle={t('cfg_help')}
        action={
          <Button
            variant="contained"
            startIcon={<SaveIcon />}
            disabled={busy || !text.trim() || text === original}
            onClick={() =>
              void start({
                action: 'config',
                config: text,
                file: file === node?.status?.config_path ? '' : base(file),
                config_kind: kinds.size > 1 ? kind : undefined,
                keep_local: keepLocal,
                verify,
              })
            }>
            {t('cfg_apply', { n: same.length })}
          </Button>
        }>
        <Stack gap={1.5}>
          <TextField
            select
            size="small"
            label={t('cfg_node')}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            sx={{ maxWidth: 340 }}>
            {nodes.map((n) => (
              <MenuItem key={n.name} value={n.name}>
                {n.address} · {kindOf(n) === 'repo' ? t('repoHost') : t('dbNode')}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
            <TextField
              select
              size="small"
              label={t('cfg_file')}
              value={file}
              onChange={(e) => setFile(e.target.value)}
              sx={{ minWidth: 340 }}>
              {files.map((f) => (
                <MenuItem key={f.path} value={f.path} sx={mono}>
                  {f.path}
                </MenuItem>
              ))}
            </TextField>
            <Typography variant="caption" color="text.secondary">
              {t('cfg_goesTo', { nodes: same.map((n) => n.address).join(', ') })}
            </Typography>
          </Stack>
          {node?.status?.config_found ? (
            <Typography variant="caption" color="text.secondary">
              {t('cfg_found', {
                path: node.status.config_path,
                how: t(`cfg_src_${node.status.config_found.source.split(' ')[0]}`, {
                  defaultValue: node.status.config_found.source,
                }),
              })}
              {node.status.config_found.include_path
                ? ` · ${t('cfg_include', { dir: node.status.config_found.include_path })}`
                : ` · ${t('cfg_noInclude')}`}
            </Typography>
          ) : null}
          <TextField
            multiline
            minRows={12}
            maxRows={30}
            value={text}
            onChange={(e) => setText(e.target.value)}
            sx={{ '& textarea': { ...mono, lineHeight: 1.5 } }}
          />
          <Stack direction="row" gap={2} flexWrap="wrap">
            <FormControlLabel
              control={<Checkbox checked={keepLocal} onChange={(e) => setKeepLocal(e.target.checked)} />}
              label={t('cfg_keepLocal')}
            />
            <FormControlLabel
              control={<Checkbox checked={verify} onChange={(e) => setVerify(e.target.checked)} />}
              label={t('cfg_verify')}
            />
          </Stack>
        </Stack>
      </Card>
      <Card title={t('cfg_diff')}>
        {status.config_diff.length ? (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>{t('cfg_setting')}</TableCell>
                  {nodeAddrs.map((a) => (
                    <TableCell key={a} sx={{ fontWeight: 700 }}>
                      {a}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {status.config_diff.map((d) => (
                  <TableRow key={`${d.kind}/${d.section}/${d.key}`}>
                    <TableCell sx={mono}>
                      [{d.section}] {d.key}
                    </TableCell>
                    {nodeAddrs.map((a) => (
                      <TableCell key={a} sx={mono}>
                        {d.values[a] ?? '—'}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : (
          <Typography color="text.secondary">{t('cfg_same')}</Typography>
        )}
      </Card>
    </Stack>
  );
};

const ScheduleTab: FC<TabProps> = ({ status, busy, start }) => {
  const { t } = useTranslation('backup');
  const all = useMemo(() => {
    const m = new Map<string, { file: string; line: string; ours: boolean; nodes: string[] }>();
    status.nodes.forEach((n) =>
      (n.status?.cron ?? []).forEach((c) => {
        // ours: one row per backup type and time, with the nodes that have it
        const f = c.line.split(/\s+/);
        const tp = /--type=(full|diff|incr)/.exec(c.line)?.[1];
        const short = c.ours && tp && f.length > 5 ? `${f.slice(0, 5).join(' ')}  ${tp}` : c.line;
        const k = `${c.ours ? 'ours' : c.file}|${short}`;
        const e = m.get(k) ?? { ...c, line: short, nodes: [] };
        e.nodes.push(n.address);
        m.set(k, e);
      }),
    );
    return [...m.values()];
  }, [status]);
  const lines = useMemo(
    () =>
      status.nodes
        .flatMap((n) => n.status?.cron ?? [])
        .filter((c) => c.ours)
        .map((c) => c.line),
    [status],
  );
  const [rows, setRows] = useState(() => cronFrom(lines));
  const others = all.filter((c) => !c.ours);
  const set = (i: number, k: keyof BCron | 'on' | 'repo', v: string | boolean) =>
    setRows(rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  const entries = rows
    .filter((r) => r.on)
    .map((r) => ({
      type: r.type,
      minute: r.minute,
      hour: r.hour,
      dom: r.dom,
      month: r.month,
      dow: r.dow,
      ...(r.repo ? { repo: r.repo } : {}),
    }));

  return (
    <Stack gap={2}>
      <Card
        title={t('t_schedule')}
        subtitle={t('s_help')}
        action={
          <Stack direction="row" gap={1}>
            <Button
              variant="contained"
              startIcon={<SaveIcon />}
              disabled={busy || !entries.length}
              onClick={() => void start({ action: 'schedule', entries })}>
              {t('s_save')}
            </Button>
            <Button
              color="error"
              disabled={busy || !lines.length}
              onClick={() => void start({ action: 'schedule', remove: true, entries: [] })}>
              {t('s_remove')}
            </Button>
          </Stack>
        }>
        <Stack gap={1.25}>
          {others.length ? <Alert severity="warning">{t('s_othersWarn', { n: others.length })}</Alert> : null}
          {rows.map((r, i) => (
            <Stack key={r.type} direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <FormControlLabel
                control={<Checkbox checked={r.on} onChange={(e) => set(i, 'on', e.target.checked)} />}
                label={<Typography fontWeight={700}>{t(r.type)}</Typography>}
                sx={{ width: 170 }}
              />
              {(['minute', 'hour', 'dom', 'month', 'dow'] as const).map((k) => (
                <TextField
                  key={k}
                  size="small"
                  label={t(`s_${k === 'minute' ? 'min' : k}`)}
                  value={r[k]}
                  disabled={!r.on}
                  onChange={(e) => set(i, k, e.target.value.replace(/\s/g, ''))}
                  sx={{ width: 96, '& input': mono }}
                />
              ))}
              <RepoPick
                status={status}
                value={r.repo ?? ''}
                onChange={(v) => set(i, 'repo', v)}
                label={t('rp_to')}
                auto={t('rp_autoBackup')}
                width={190}
              />
            </Stack>
          ))}
        </Stack>
      </Card>
      <Card title={t('s_current')}>
        {all.length ? (
          <Stack gap={1}>
            {all.map((c) => (
              <Box key={`${c.file}|${c.line}`}>
                <Typography variant="caption" color="text.secondary">
                  {c.file} · {c.nodes.join(', ')}
                  {c.ours ? '' : ` · ${t('s_other')}`}
                </Typography>
                <Box sx={{ ...mono, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{c.line}</Box>
              </Box>
            ))}
          </Stack>
        ) : (
          <Typography color="text.secondary">{t('s_none')}</Typography>
        )}
      </Card>
    </Stack>
  );
};

const NodesTab: FC<{ status: BStatus; roles: Record<string, string> }> = ({ status, roles }) => {
  const { t } = useTranslation('backup');
  return (
    <Card>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              {['n_node', 'n_role', 'n_version', 'n_config', 'n_pg', 'n_archive', 'n_cron', 'n_status'].map((k) => (
                <TableCell key={k} sx={{ fontWeight: 700 }}>
                  {t(k)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {status.nodes.map((n) => (
              <TableRow key={n.name}>
                <TableCell sx={mono}>{n.address}</TableCell>
                <TableCell>{roles[n.address]}</TableCell>
                <TableCell>{n.status?.version ?? '—'}</TableCell>
                <TableCell sx={{ ...mono, fontSize: 12 }}>
                  {n.status?.config_path ?? '—'}
                  {n.status?.config_found ? (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {t(`cfg_src_${n.status.config_found.source.split(' ')[0]}`, { defaultValue: n.status.config_found.source })}
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell sx={{ ...mono, fontSize: 12, minWidth: 280, maxWidth: 360, wordBreak: 'break-all' }}>
                  {n.status?.pg?.data_directory || n.status?.pg_conf?.data_dir || '—'}
                  {n.status?.pg?.port ? `:${n.status.pg.port}` : ''}
                  {n.status?.pg?.files ? (
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ wordBreak: 'break-all' }}>
                      {n.status.pg.files.config_file}
                      <br />
                      {t('n_logs')}: {n.status.pg.files.log_directory}/{n.status.pg.files.log_filename}
                      {n.status.pg.files.logging_collector === 'off' ? ` (${t('n_logsOff', { dest: n.status.pg.files.log_destination })})` : ''}
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell sx={mono}>
                  {n.status?.pg?.last_archived_wal || '—'}
                  {n.status?.pg?.last_archived_time ? (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {when(n.status.pg.last_archived_time.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'))}
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell>{n.status?.cron?.length ?? 0}</TableCell>
                <TableCell>
                  <Chip size="small" color={n.ok ? 'success' : 'error'} label={n.ok ? 'OK' : n.error?.slice(0, 80)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
};

const History: FC<{ jobs: BJob[]; openJob: (id: number) => void }> = ({ jobs, openJob }) => {
  const { t } = useTranslation('backup');
  if (!jobs.length) return <Typography color="text.secondary">{t('h_none')}</Typography>;
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            {['h_job', 'type', 'n_status', 'h_by', 'h_when', ''].map((k) => (
              <TableCell key={k} sx={{ fontWeight: 700 }}>
                {k ? t(k) : ''}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {jobs.map((j) => (
            <TableRow key={j.id} hover>
              <TableCell>
                #{j.id} · {t(`a_${j.action}`)}
              </TableCell>
              <TableCell>{jobKind(j, t)}</TableCell>
              <TableCell>
                <Chip size="small" color={STATUS[j.status]} label={t(`st_${j.status}`, { ns: 'upgrade' })} />
              </TableCell>
              <TableCell>{j.created_by}</TableCell>
              <TableCell>{when(j.created_at)}</TableCell>
              <TableCell align="right">
                <Button size="small" onClick={() => openJob(j.id)}>
                  {t('open')}
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

type BStep = { host: string; phase: string; status: string; detail?: Record<string, unknown> };
const isStep = (r: unknown): r is BStep => !!r && typeof r === 'object' && 'phase' in r && 'host' in r;

const JobResult: FC<{ job: BJob }> = ({ job }) => {
  const { t } = useTranslation('backup');
  if (!job.result?.length) return null;
  return (
    <Card title={t('result')}>
      <Stack gap={0.75}>
        {job.result.map((r, i) =>
          !isStep(r) ? (
            <Alert key={i} severity="error">
              {(r as { error?: string }).error}
            </Alert>
          ) : (
            <Stack key={i} direction="row" gap={1} alignItems="center" flexWrap="wrap">
              <Chip
                size="small"
                color={r.status === 'success' ? 'success' : r.status === 'failed' ? 'error' : 'default'}
                label={r.status}
              />
              <Typography variant="body2" fontWeight={700}>
                {r.host}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {r.phase}
              </Typography>
              {(r.detail as { error?: string })?.error ? (
                <Typography variant="body2" color="error">
                  {(r.detail as { error?: string }).error}
                </Typography>
              ) : null}
              {((r.detail as { warnings?: string[] })?.warnings ?? []).map((w) => (
                <Typography key={w} variant="caption" color="warning.main">
                  {w}
                </Typography>
              ))}
            </Stack>
          ),
        )}
      </Stack>
    </Card>
  );
};

export default Backups;
