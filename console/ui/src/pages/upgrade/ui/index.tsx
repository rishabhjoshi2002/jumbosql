import { FC, useCallback, useEffect, useMemo, useState } from 'react';
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
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import FactCheckIcon from '@mui/icons-material/FactCheckOutlined';
import UndoIcon from '@mui/icons-material/Undo';
import ReplayIcon from '@mui/icons-material/Replay';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useSearchParams } from 'react-router-dom';
import { useGetDiscoveryQuery } from '@shared/api/api/discover.ts';
import {
  UHostResult,
  Upgrade,
  UpgradeRequest,
  useGetUpgradeComponentsQuery,
  useGetUpgradeQuery,
  useGetUpgradesQuery,
  UTarget,
  usePostUpgradeMutation,
} from '@shared/api/api/upgrade.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import Card from '@pages/discover/ui/Card.tsx';
import { planOf } from '../lib/plan.ts';
import { BUILTIN_STEPS, builtinSteps } from '../lib/ansibleLog.ts';
import FlowStepper, { flowSteps } from './FlowStepper.tsx';
import RunView from './RunView.tsx';
import TargetSelect from './TargetSelect.tsx';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };
const STATUS = { running: 'info', success: 'success', failed: 'error' } as const;
const isHost = (r: unknown): r is UHostResult => !!r && typeof r === 'object' && 'host' in r;
const stepOf = (task: string) => BUILTIN_STEPS[task];

/** pg_mantra Upgrades: one component of any cluster (created by pg_mantra or found by Discover) - dry run,
 * upgrade (old version kept), rollback - with a live picture of the run next to its Ansible log. */
const BuiltInUpgrades: FC = () => {
  const { t } = useTranslation('upgrade');
  const [params] = useSearchParams();
  const [target, setTarget] = useState<UTarget | null>(() => {
    const d = Number(params.get('discovery'));
    const c = Number(params.get('cluster'));
    return d ? { kind: 'discoveries', id: d } : c ? { kind: 'clusters', id: c } : null;
  });
  const onTarget = useCallback((v: UTarget | null) => {
    setTarget(v);
    setSelected(0);
    setView('form');
  }, []);
  const kind = target?.kind;
  const discovery = useGetDiscoveryQuery(target?.id ?? 0, { skip: kind !== 'discoveries' || !target?.id });
  // components Discover found in the setup, and on which machines
  const found = useMemo(() => {
    const m: Record<string, { label: string; address: string }[]> = {};
    (discovery.data?.result.infra?.hosts ?? []).forEach((h) =>
      h.components.forEach((c) =>
        (m[c.kind] ??= []).push({
          label: h.name && h.name !== h.address ? `${h.name} (${h.address})` : h.address,
          address: h.address,
        }),
      ),
    );
    return m;
  }, [discovery.data]);
  const [compName, setCompName] = useState('postgres');
  const [form, setForm] = useState({
    target: '',
    binary_url: '',
    ssh_user: '',
    ssh_password: '',
    ssh_key: '',
    ssh_port: '22',
    repo_url: '',
    repo_gpgkey: '',
  });
  const [repoOnly, setRepoOnly] = useState(false);
  const [repoGpg, setRepoGpg] = useState(false);
  const [allowUnsaved, setAllowUnsaved] = useState(false);
  const [restoreConfig, setRestoreConfig] = useState(false);
  const [selected, setSelected] = useState<number>(0);
  const [view, setView] = useState<'form' | 'run'>('form');
  const [confirm, setConfirm] = useState<null | 'run' | 'rollback'>(null);
  const components = useGetUpgradeComponentsQuery();
  const offered = useMemo(
    () => (components.data ?? []).filter((c) => kind === 'clusters' || !discovery.data || found[c.name]),
    [components.data, kind, discovery.data, found],
  );
  const comp = components.data?.find((c) => c.name === compName);
  useEffect(() => {
    if (offered.length && !offered.some((c) => c.name === compName)) setCompName(offered[0].name);
  }, [offered, compName]);

  const [running, setRunning] = useState(false);
  const list = useGetUpgradesQuery(target ?? { kind: 'discoveries', id: 0 }, {
    skip: !target?.id,
    pollingInterval: running ? 3000 : 0,
  });
  const upgrades = useMemo(() => (list.data ?? []).filter((u) => u.component === compName), [list.data, compName]);
  useEffect(() => setRunning((list.data ?? []).some((u) => u.status === 'running')), [list.data]);
  // a run still going (e.g. after a page reload): show it
  useEffect(() => {
    const r = upgrades.find((u) => u.status === 'running');
    if (r && view === 'form') {
      setSelected(r.id);
      setView('run');
    }
  }, [upgrades, view]);
  const current: Upgrade | undefined = upgrades.find((u) => u.id === selected);
  const detail = useGetUpgradeQuery(
    { ...(target ?? { kind: 'discoveries', id: 0 }), uid: current?.id ?? 0 },
    { skip: !current?.id || !target, pollingInterval: current?.status === 'running' ? 2000 : 0 },
  );
  const log = detail.data?.id === current?.id ? (detail.data?.log ?? '') : '';
  const [post, posting] = usePostUpgradeMutation();

  const lastPlan = upgrades.find((u) => u.action === 'plan');
  const lastRun = upgrades.find((u) => u.action === 'run');
  const lastRollback = upgrades.find((u) => u.action === 'rollback');
  const rolledBack =
    lastRun && upgrades.some((u) => u.action === 'rollback' && u.parent_id === lastRun.id && u.status === 'success');
  const steps = flowSteps([t('s1'), t('s2'), t('s3'), t('s4')], {
    plan: lastPlan,
    run: lastRun,
    rollback: lastRollback,
  });
  const planRun =
    current?.action === 'plan' ? current : (upgrades.find((u) => u.id === current?.parent_id) ?? lastPlan);
  const plan = useMemo(() => planOf(planRun?.result?.filter(isHost) ?? [], comp, t), [planRun, comp, t]);
  const anyChange = plan.some((h) => h.changes.length);
  const anyError = plan.some((h) => h.error);
  const hostResults = (current?.result ?? []).filter(isHost);
  // the machines in the order they will be done, and their roles - for the live picture
  const knownHosts = useMemo(
    () =>
      current?.action === 'plan' || !plan.length
        ? (found[compName] ?? []).map((f) => f.address)
        : plan.map((h) => h.host),
    [current, plan, found, compName],
  );
  const roles = useMemo(() => Object.fromEntries(plan.filter((h) => h.role).map((h) => [h.host, h.role])), [plan]);

  const start = async (action: UpgradeRequest['action'], parent?: number) => {
    if (!target) return;
    try {
      const out = await post({
        target,
        body: {
          component: compName,
          action,
          parent_id: parent,
          target: action === 'plan' ? form.target.trim() || undefined : undefined,
          binary_url: action === 'plan' && compName === 'etcd' ? form.binary_url.trim() || undefined : undefined,
          allow_unsaved: action === 'run' ? allowUnsaved : undefined,
          restore_config: action === 'rollback' ? restoreConfig : undefined,
          ssh_user: form.ssh_user.trim() || undefined,
          ssh_password: form.ssh_user.trim() ? form.ssh_password || undefined : undefined,
          ssh_key: form.ssh_user.trim() ? form.ssh_key.trim() || undefined : undefined,
          ssh_port: Number(form.ssh_port) || undefined,
          repo_url: action === 'plan' ? form.repo_url.trim() || undefined : undefined,
          repo_only: action === 'plan' && form.repo_url.trim() ? repoOnly : undefined,
          repo_gpgcheck: action === 'plan' && form.repo_url.trim() ? repoGpg : undefined,
          repo_gpgkey: action === 'plan' && repoGpg ? form.repo_gpgkey.trim() || undefined : undefined,
        },
      }).unwrap();
      setSelected(out.id);
      setView('run');
      setRunning(true);
      toast.success(t(`started_${action}`));
    } catch (e) {
      toast.error(String((e as { data?: { title?: string } }).data?.title ?? t('failed')));
    }
  };

  const field = (k: keyof typeof form, label: string, extra: object = {}) => (
    <TextField
      size="small"
      label={label}
      value={form[k]}
      onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
      {...extra}
    />
  );
  const needLogin = kind === 'discoveries' && !form.ssh_user.trim();

  /* ------------------------------------------------------------ what comes next, under the run */
  const actions = (() => {
    if (!current || current.status === 'running') return null;
    const tryAgain = (
      <Button variant="outlined" startIcon={<ReplayIcon />} onClick={() => setView('form')}>
        {t('tryAgain')}
      </Button>
    );
    if (current.action === 'plan') {
      if (current.status === 'failed' || anyError) {
        return (
          <>
            <Alert severity="warning" sx={{ flex: 1 }}>
              {current.status === 'failed' ? t('planFailedFix') : t('fixFirst')}
            </Alert>
            {tryAgain}
          </>
        );
      }
      if (!anyChange) return <Alert severity="success">{t('nothingToDo')}</Alert>;
      if (current.id !== lastPlan?.id) return null;
      return (
        <>
          <Button
            variant="contained"
            color="warning"
            size="large"
            startIcon={<PlayArrowIcon />}
            disabled={running}
            onClick={() => setConfirm('run')}>
            {t('proceed')}
          </Button>
          <FormControlLabel
            control={<Checkbox checked={allowUnsaved} onChange={(e) => setAllowUnsaved(e.target.checked)} />}
            label={<Typography variant="body2">{t('allowUnsaved')}</Typography>}
          />
          <Button onClick={() => setView('form')}>{t('changeSettings')}</Button>
        </>
      );
    }
    if (current.action === 'run' && current.id === lastRun?.id && !rolledBack) {
      if (current.status === 'failed') {
        return (
          <>
            <Alert severity="error" sx={{ flex: 1 }}>
              {t('runFailed')}
            </Alert>
            <Button
              variant="contained"
              color="error"
              size="large"
              startIcon={<UndoIcon />}
              disabled={running || posting.isLoading}
              onClick={() => void start('rollback', current.id)}>
              {t('rollbackNow')}
            </Button>
            {tryAgain}
          </>
        );
      }
      return (
        <>
          <Alert severity="success" sx={{ flex: 1 }}>
            {t('runDone')}
          </Alert>
          <Button variant="outlined" color="error" startIcon={<UndoIcon />} onClick={() => setConfirm('rollback')}>
            {t('rollback')}
          </Button>
          <FormControlLabel
            control={<Checkbox checked={restoreConfig} onChange={(e) => setRestoreConfig(e.target.checked)} />}
            label={<Typography variant="body2">{t('restoreConfig')}</Typography>}
          />
        </>
      );
    }
    if (current.action === 'rollback') {
      return current.status === 'failed' && lastRun ? (
        <>
          <Alert severity="error" sx={{ flex: 1 }}>
            {t('rollbackFailed')}
          </Alert>
          <Button
            variant="contained"
            color="error"
            startIcon={<ReplayIcon />}
            disabled={running || posting.isLoading}
            onClick={() => void start('rollback', lastRun.id)}>
            {t('rollbackAgain')}
          </Button>
          {tryAgain}
        </>
      ) : (
        <Alert severity="success">{t('rollbackDone')}</Alert>
      );
    }
    return null;
  })();

  /* ------------------------------------------------------------ the detailed result */
  const details =
    current && current.status !== 'running' ? (
      <Card title={t('details')}>
        {(current.result ?? [])
          .filter((r) => !isHost(r))
          .map((r, i) => (
            <Alert key={i} severity="error" sx={{ mb: 1 }}>
              {(r as { error: string }).error}
            </Alert>
          ))}
        {current.options?.target ? (
          <Typography variant="body2" mb={1}>
            {t('targetIs', { v: current.options.target })}
          </Typography>
        ) : null}
        {current.action === 'plan' ? (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                    <TableCell>#</TableCell>
                    <TableCell>{t('node')}</TableCell>
                    <TableCell>{t('role')}</TableCell>
                    <TableCell>{t('change')}</TableCell>
                    <TableCell>{t('services')}</TableCell>
                    <TableCell align="right">{t('free')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {plan.map((h, i) => (
                    <TableRow key={h.host}>
                      <TableCell>{i + 1}</TableCell>
                      <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{h.host}</TableCell>
                      <TableCell>{h.role || '—'}</TableCell>
                      <TableCell sx={mono}>
                        {h.error ? (
                          <Typography color="error" variant="body2">
                            {h.error}
                          </Typography>
                        ) : h.changes.length ? (
                          h.changes.map((c) => (
                            <div key={c.name}>
                              {c.name}: {c.from} → <b>{c.to}</b>
                            </div>
                          ))
                        ) : (
                          <Typography variant="body2" color="text.secondary">
                            {h.detect?.method === 'none' ? t('s_notInstalled') : t('upToDate')}
                          </Typography>
                        )}
                        {h.warnings.map((w) => (
                          <Typography key={w} variant="caption" color="warning.main" display="block">
                            {w}
                          </Typography>
                        ))}
                      </TableCell>
                      <TableCell>
                        {(h.detect?.services ?? []).map((s) => `${s.name} ${s.active ? '●' : '○'}`).join(', ') || '—'}
                      </TableCell>
                      <TableCell align="right">{h.detect?.free_bytes ? bytes(h.detect.free_bytes) : '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {anyChange ? (
              <Box sx={{ display: 'grid', gap: 2, mt: 2, gridTemplateColumns: { xs: '1fr', xl: '1fr 1fr' } }}>
                {(['whatHappens', 'rollbackPlan'] as const).map((k) => (
                  <Box key={k}>
                    <Typography fontWeight={700} mb={0.5}>
                      {t(k)}
                    </Typography>
                    {plan
                      .filter((h) => h.changes.length)
                      .map((h, i) => (
                        <Box key={h.host} mb={1}>
                          <Typography variant="body2" fontWeight={700}>
                            {i + 1}. {h.host} {h.role ? `(${h.role})` : ''}
                          </Typography>
                          <Box component="ol" sx={{ m: 0, pl: 3 }}>
                            {(k === 'whatHappens' ? h.steps : h.rollback).map((s) => (
                              <Typography component="li" variant="body2" key={s}>
                                {s}
                              </Typography>
                            ))}
                          </Box>
                        </Box>
                      ))}
                    <Typography variant="caption" color="text.secondary">
                      {k === 'whatHappens' ? t('stopRule') : t('keptIn')}
                    </Typography>
                  </Box>
                ))}
              </Box>
            ) : null}
          </>
        ) : hostResults.length ? (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                  <TableCell>{t('node')}</TableCell>
                  <TableCell>{t('result')}</TableCell>
                  <TableCell>{t('versions')}</TableCell>
                  <TableCell>{t('kept')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {hostResults.map((r) => (
                  <TableRow key={r.host}>
                    <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{r.host}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={r.status === 'failed' ? 'error' : r.status === 'success' ? 'success' : 'default'}
                        label={t(`st_${r.status ?? 'skipped'}`)}
                      />
                      {r.error ? (
                        <Typography variant="caption" color="error" display="block" mt={0.5}>
                          {r.task ? `${r.task}: ` : ''}
                          {r.error}
                        </Typography>
                      ) : null}
                      {r.reason ? (
                        <Typography variant="caption" color="text.secondary" display="block">
                          {r.reason}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell sx={mono}>
                      {Object.entries(r.change?.after ?? {}).map(([k, v]) => (
                        <div key={k}>
                          {k}: {r.change?.before?.[k]} → <b>{v}</b>
                        </div>
                      ))}
                    </TableCell>
                    <TableCell sx={mono}>
                      {(r.preserve?.saved ?? []).map((s) => (
                        <div key={s.name}>
                          {s.name} {s.version} ✓
                        </div>
                      ))}
                      {(r.preserve?.unsaved ?? []).map((s) => (
                        <Typography key={s.name} variant="caption" color="warning.main" display="block">
                          {s.name} {s.version}: {t('notKept')}
                        </Typography>
                      ))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : null}
      </Card>
    ) : null;

  const stepper = (
    <Card>
      <FlowStepper steps={steps} running={running} />
    </Card>
  );

  if (view === 'run' && current) {
    return (
      <Stack gap={2}>
        {stepper}
        <RunView
          title={`#${current.id} ${t(`a_${current.action}`)} · ${comp?.label ?? current.component}`}
          status={current.status}
          log={log}
          knownHosts={knownHosts}
          steps={builtinSteps(current.action)}
          stepOf={stepOf}
          roles={roles}
          actions={actions}
          onBack={() => setView('form')}>
          {details}
        </RunView>
        {confirmDialog()}
      </Stack>
    );
  }

  function confirmDialog() {
    return (
      <Dialog open={!!confirm} onClose={() => setConfirm(null)}>
        <DialogTitle>{confirm === 'run' ? t('confirmRunTitle') : t('confirmRollbackTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirm === 'run'
              ? t('confirmRun', { comp: comp?.label, n: plan.filter((h) => h.changes.length).length })
              : t('confirmRollback', { comp: comp?.label })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            color={confirm === 'run' ? 'warning' : 'error'}
            onClick={() => {
              const c = confirm;
              setConfirm(null);
              if (c === 'run' && lastPlan) void start('run', lastPlan.id);
              if (c === 'rollback' && lastRun) void start('rollback', lastRun.id);
            }}>
            {confirm === 'run' ? t('proceed') : t('rollback')}
          </Button>
        </DialogActions>
      </Dialog>
    );
  }

  return (
    <Stack gap={2}>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          alignItems: 'start',
          gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: '360px minmax(0,1fr)' },
        }}>
        <Card title={t('what')}>
          <Stack gap={1.5}>
            <TargetSelect value={target} onChange={onTarget} />
            <TextField
              select
              size="small"
              label={t('component')}
              value={compName}
              onChange={(e) => {
                setCompName(e.target.value);
                setSelected(0);
              }}>
              {offered.map((c) => (
                <MenuItem key={c.name} value={c.name}>
                  {c.label}
                </MenuItem>
              ))}
            </TextField>
            {comp ? (
              <Box sx={{ bgcolor: 'action.hover', borderRadius: 1.5, p: 1.25 }}>
                <Typography variant="caption" component="div">
                  <b>{t('where')}:</b>{' '}
                  {kind === 'discoveries'
                    ? (found[comp.name] ?? []).map((f) => f.label).join(', ') || '—'
                    : comp.groups.join(', ')}
                </Typography>
                <Typography variant="caption" component="div">
                  <b>{t('order')}:</b> {t(`order_${comp.order}`)}
                </Typography>
                <Typography variant="caption" component="div">
                  <b>{t('restart')}:</b> {comp.restart}
                </Typography>
                {(comp.notes ?? []).map((n) => (
                  <Typography key={n} variant="caption" component="div" color="text.secondary">
                    · {n}
                  </Typography>
                ))}
              </Box>
            ) : null}
            {field('target', t('target'), { placeholder: t('targetPlaceholder') })}
            {compName === 'etcd'
              ? field('binary_url', t('binaryUrl'), {
                  placeholder: 'https://github.com/etcd-io/etcd/releases/download/v{version}/...',
                })
              : null}
            {field('repo_url', t('repoUrl'), { placeholder: t('repoPlaceholder'), helperText: t('repoHelp') })}
            {form.repo_url.trim() ? (
              <Stack>
                <FormControlLabel
                  control={<Checkbox size="small" checked={repoOnly} onChange={(e) => setRepoOnly(e.target.checked)} />}
                  label={<Typography variant="body2">{t('repoOnly')}</Typography>}
                />
                <FormControlLabel
                  control={<Checkbox size="small" checked={repoGpg} onChange={(e) => setRepoGpg(e.target.checked)} />}
                  label={<Typography variant="body2">{t('repoGpg')}</Typography>}
                />
                {repoGpg
                  ? field('repo_gpgkey', t('repoGpgKey'), { placeholder: 'https://repo.example/RPM-GPG-KEY' })
                  : null}
              </Stack>
            ) : null}
            <Typography variant="body2" fontWeight={700} mt={0.5}>
              {t('sshTitle')}
            </Typography>
            <Typography variant="caption" color="text.secondary" mt={-1}>
              {kind === 'clusters' ? t('sshHelp') : t('sshHelpDiscovered')}
            </Typography>
            <Stack direction="row" gap={1}>
              {field('ssh_user', t('sshUser'), { fullWidth: true, autoComplete: 'off' })}
              {field('ssh_port', t('sshPort'), { sx: { width: 90, flexShrink: 0 } })}
            </Stack>
            {field('ssh_password', t('sshPassword'), { type: 'password', autoComplete: 'new-password' })}
            {field('ssh_key', t('sshKey'), { multiline: true, minRows: 2, maxRows: 5, InputProps: { sx: mono } })}
            <Button
              variant="contained"
              size="large"
              startIcon={posting.isLoading ? <CircularProgress size={18} color="inherit" /> : <FactCheckIcon />}
              disabled={!target?.id || posting.isLoading || running || needLogin}
              onClick={() => void start('plan')}>
              {t('dryRun')}
            </Button>
            {running ? <Alert severity="info">{t('busy')}</Alert> : null}
          </Stack>
        </Card>

        <Stack gap={2} minWidth={0}>
          {stepper}
          {(() => {
            // what to do next, so a finished dry run or a failed upgrade is never missed
            const open = (id: number) => {
              setSelected(id);
              setView('run');
            };
            if (lastRun?.status === 'failed' && !rolledBack && (!lastPlan || lastRun.id > lastPlan.id))
              return (
                <Alert
                  severity="error"
                  action={
                    <Button color="inherit" size="small" variant="outlined" onClick={() => open(lastRun.id)}>
                      {t('next_open')}
                    </Button>
                  }>
                  {t('next_failed', { id: lastRun.id })}
                </Alert>
              );
            if (lastPlan?.status === 'success' && (!lastRun || lastRun.id < lastPlan.id))
              return (
                <Alert
                  severity="info"
                  action={
                    <Button color="inherit" size="small" variant="outlined" onClick={() => open(lastPlan.id)}>
                      {t('next_review')}
                    </Button>
                  }>
                  {t('next_planDone', { id: lastPlan.id })}
                </Alert>
              );
            return null;
          })()}
          <Card title={t('history')}>
            <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
              {upgrades.map((u) => (
                <Stack
                  key={u.id}
                  direction="row"
                  alignItems="center"
                  gap={1}
                  py={0.75}
                  px={0.75}
                  sx={{ cursor: 'pointer', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
                  onClick={() => {
                    setSelected(u.id);
                    setView('run');
                  }}>
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" fontWeight={700}>
                      #{u.id} {t(`a_${u.action}`)}
                      {u.options?.target ? ` · ${u.options.target}` : ''}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(u.created_at).toLocaleString()} · {u.created_by || '—'}
                    </Typography>
                  </Box>
                  <Chip size="small" color={STATUS[u.status]} label={t(`st_${u.status}`)} sx={{ fontWeight: 700 }} />
                </Stack>
              ))}
              {!upgrades.length ? (
                <Typography variant="body2" color="text.secondary">
                  {t('start')}
                </Typography>
              ) : null}
            </Stack>
          </Card>
        </Stack>
      </Box>
      {confirmDialog()}
    </Stack>
  );
};

export default BuiltInUpgrades;
