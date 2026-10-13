import { FC, useEffect, useMemo, useState } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Autocomplete,
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
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/EditOutlined';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FactCheckIcon from '@mui/icons-material/FactCheckOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import UndoIcon from '@mui/icons-material/Undo';
import ReplayIcon from '@mui/icons-material/Replay';
import GitHubIcon from '@mui/icons-material/GitHub';
import SyncIcon from '@mui/icons-material/Sync';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useGetDiscoveryQuery } from '@shared/api/api/discover.ts';
import {
  PHostResult,
  Playbook,
  PlaybookRun,
  PlaybookRunRequest,
  PVariable,
  useDeletePlaybookMutation,
  useGetPlaybookRunQuery,
  useGetPlaybookRunsQuery,
  useGetPlaybooksQuery,
  usePostPlaybookRunMutation,
  usePutPlaybookMutation,
} from '@shared/api/api/playbooks.ts';
import { UTarget } from '@shared/api/api/upgrade.ts';
import Card from '@pages/discover/ui/Card.tsx';
import PlaybookEditor from './PlaybookEditor.tsx';
import FlowStepper, { flowSteps } from './FlowStepper.tsx';
import RunView from './RunView.tsx';
import TargetSelect, { useTargetNames } from './TargetSelect.tsx';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };
const STATUS = { running: 'info', success: 'success', failed: 'error' } as const;
const isHost = (r: unknown): r is PHostResult => !!r && typeof r === 'object' && 'host' in r;
const errText = (e: unknown, t: (k: string) => string) =>
  String((e as { data?: { title?: string } }).data?.title ?? t('failed'));

type Machines = 'ips' | 'cluster' | 'inventory';

/** the addresses typed by the user (one per line, or separated by commas / spaces) */
export const ipList = (s: string) => [
  ...new Set(
    s
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

/** an inventory where every group of the playbook (and all) holds the given machines */
export const ipInventory = (ips: string[], groups: string[]) =>
  ['[pgm_targets]', ...ips, '', ...groups.flatMap((g) => [`[${g}:children]`, 'pgm_targets', ''])].join('\n');

/** pg_mantra Ansible Playbooks: your own playbooks, by name, run on the machines you choose (IP addresses and a
 * login, a cluster, or your inventory) - dry run (--check --diff), run, rollback, with a live picture and the log. */
const CustomPlaybooks: FC = () => {
  const { t } = useTranslation('upgrade');
  const playbooks = useGetPlaybooksQuery();
  const [pid, setPid] = useState(0);
  const pb: Playbook | undefined = playbooks.data?.find((p) => p.id === pid);
  const [editor, setEditor] = useState<{ open: boolean; edit?: Playbook | null }>({ open: false });
  const [del, deleting] = useDeletePlaybookMutation();
  const [askDelete, setAskDelete] = useState(false);
  // pull the latest from GitHub (a token only for a private repository, never saved)
  const [pullOpen, setPullOpen] = useState(false);
  const [pullToken, setPullToken] = useState('');
  const [putPb, putting] = usePutPlaybookMutation();
  const pullLatest = async () => {
    if (!pb) return;
    try {
      await putPb({
        id: pb.id,
        body: {
          name: pb.name,
          description: pb.description,
          playbook: pb.playbook,
          playbook_path: pb.playbook_path,
          rollback: pb.rollback,
          rollback_path: pb.rollback_path,
          requirements: pb.requirements,
          variables: pb.variables ?? [],
          groups: pb.groups ?? [],
          git_url: pb.git_url,
          git_ref: pb.git_ref,
          git_token: pullToken.trim() || undefined,
          git_pull: true,
        },
      }).unwrap();
      toast.success(t('pb.pulled'));
      setPullOpen(false);
      setPullToken('');
    } catch (e) {
      toast.error(errText(e, t));
    }
  };
  useEffect(() => {
    if (!pb && playbooks.data?.length) setPid(playbooks.data[0].id);
  }, [pb, playbooks.data]);

  // the machines
  const names = useTargetNames();
  const [machines, setMachines] = useState<Machines>('ips');
  const [ips, setIps] = useState('');
  const [target, setTarget] = useState<UTarget | null>(null);
  const [inventory, setInventory] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const discovery = useGetDiscoveryQuery(target?.id ?? 0, {
    skip: machines !== 'cluster' || target?.kind !== 'discoveries' || !target?.id,
  });
  const hostOptions = useMemo(
    () => (discovery.data?.result.infra?.hosts ?? []).map((h) => h.address),
    [discovery.data],
  );

  // the inputs and the login
  const [vals, setVals] = useState<Record<string, unknown>>({});
  const [login, setLogin] = useState({ user: '', port: '22', password: '', key: '', become: '', vault: '' });
  const [extraVars, setExtraVars] = useState('');
  const [verbose, setVerbose] = useState(false);
  const defs: PVariable[] = useMemo(() => pb?.variables ?? [], [pb]);
  useEffect(() => {
    const v: Record<string, unknown> = {};
    defs.forEach((d) => (v[d.name] = d.default ?? (d.type === 'boolean' ? false : '')));
    setVals(v);
  }, [defs]);

  // runs
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<'form' | 'run'>('form');
  const [running, setRunning] = useState(false);
  const runs = useGetPlaybookRunsQuery(pid, { skip: !pid, pollingInterval: running ? 3000 : 0 });
  useEffect(() => setRunning((runs.data ?? []).some((r) => r.status === 'running')), [runs.data]);
  const list = useMemo(() => runs.data ?? [], [runs.data]);
  useEffect(() => {
    const r = list.find((x) => x.status === 'running');
    if (r && view === 'form') {
      setSelected(r.id);
      setView('run');
    }
  }, [list, view]);
  const current: PlaybookRun | undefined = list.find((r) => r.id === selected);
  const detail = useGetPlaybookRunQuery(
    { id: pid, uid: current?.id ?? 0 },
    { skip: !current?.id, pollingInterval: current?.status === 'running' ? 2000 : 0 },
  );
  const log = detail.data?.id === current?.id ? (detail.data?.log ?? '') : '';
  const lastPlan = list.find((r) => r.action === 'plan');
  const lastRun = list.find((r) => r.action === 'run');
  const lastRollback = list.find((r) => r.action === 'rollback');
  const rolledBack =
    lastRun && list.some((r) => r.action === 'rollback' && r.parent_id === lastRun.id && r.status === 'success');
  const steps = flowSteps([t('pb.s1'), t('pb.s2'), t('pb.s3'), t('pb.s4')], {
    plan: lastPlan,
    run: lastRun,
    rollback: lastRollback,
  });
  const [confirm, setConfirm] = useState<null | 'run' | 'rollback'>(null);
  const [post, posting] = usePostPlaybookRunMutation();

  const missing = defs.filter(
    (d) => d.required && d.type !== 'boolean' && (vals[d.name] === '' || vals[d.name] == null),
  );
  const ipsList = ipList(ips);
  const noMachines =
    (machines === 'ips' && !ipsList.length) ||
    (machines === 'cluster' && !target?.id) ||
    (machines === 'inventory' && !inventory.trim());
  const needLogin = (machines === 'ips' || target?.kind === 'discoveries') && !login.user.trim();

  const start = async (action: PlaybookRunRequest['action'], parent?: number) => {
    if (!pb) return;
    const body: PlaybookRunRequest = {
      action,
      parent_id: parent,
      ssh_user: login.user.trim() || undefined,
      ssh_port: Number(login.port) || undefined,
      ssh_password: login.user.trim() ? login.password || undefined : undefined,
      ssh_key: login.user.trim() ? login.key.trim() || undefined : undefined,
      become_password: login.become || undefined,
      vault_password: login.vault || undefined,
      verbose,
    };
    if (action === 'plan') {
      // the dry run fixes the machines and the inputs; the run and the rollback reuse them
      if (machines === 'ips')
        body.inventory = ipInventory(
          ipsList,
          (pb.groups ?? []).map((g) => g.group),
        );
      if (machines === 'inventory') body.inventory = inventory;
      if (machines === 'cluster' && target) {
        if (target.kind === 'discoveries') body.discovery_id = target.id;
        else body.cluster_id = target.id;
        body.hosts = hosts.length ? hosts : undefined;
      }
      body.vars = vals;
      body.extra_vars = extraVars.trim() || undefined;
    } else {
      body.vars = Object.fromEntries(defs.filter((d) => d.type === 'password').map((d) => [d.name, vals[d.name]]));
    }
    try {
      const out = await post({ id: pb.id, body }).unwrap();
      setSelected(out.id);
      setView('run');
      setRunning(true);
      toast.success(t(`pb.started_${action}`));
    } catch (e) {
      toast.error(errText(e, t));
    }
  };

  const input = (d: PVariable) => {
    const label = `${d.label || d.name}${d.required && d.type !== 'boolean' ? ' *' : ''}`;
    const v = vals[d.name];
    const set = (x: unknown) => setVals((s) => ({ ...s, [d.name]: x }));
    if (d.type === 'boolean')
      return (
        <FormControlLabel
          key={d.name}
          control={<Checkbox size="small" checked={!!v} onChange={(e) => set(e.target.checked)} />}
          label={<Typography variant="body2">{label}</Typography>}
        />
      );
    return (
      <TextField
        key={d.name}
        size="small"
        label={label}
        value={v == null ? '' : String(v)}
        onChange={(e) => set(e.target.value)}
        select={d.type === 'select'}
        type={d.type === 'password' ? 'password' : d.type === 'number' ? 'number' : 'text'}
        multiline={d.type === 'textarea'}
        minRows={d.type === 'textarea' ? 2 : undefined}
        autoComplete={d.type === 'password' ? 'new-password' : 'off'}
        helperText={d.help || <span style={mono}>{d.name}</span>}>
        {(d.options ?? []).map((o) => (
          <MenuItem key={o} value={o}>
            {o}
          </MenuItem>
        ))}
      </TextField>
    );
  };

  const field = (k: keyof typeof login, label: string, extra: object = {}) => (
    <TextField
      size="small"
      label={label}
      value={login[k]}
      onChange={(e) => setLogin((f) => ({ ...f, [k]: e.target.value }))}
      {...extra}
    />
  );

  const where = (r?: PlaybookRun) => {
    const o = r?.options;
    if (!o) return '';
    if (o.discovery_id) return names[`discoveries:${o.discovery_id}`] ?? `#${o.discovery_id}`;
    if (o.cluster_id) return names[`clusters:${o.cluster_id}`] ?? `#${o.cluster_id}`;
    const fromIps = (o.inventory ?? '').startsWith('[pgm_targets]')
      ? ipList((o.inventory ?? '').split('\n\n')[0].replace('[pgm_targets]', ''))
      : [];
    return fromIps.length ? fromIps.join(', ') : t('pb.ownInventory');
  };
  const knownHosts = useMemo(() => {
    const o = current?.options;
    if (o?.inventory?.startsWith('[pgm_targets]'))
      return ipList(o.inventory.split('\n\n')[0].replace('[pgm_targets]', ''));
    return o?.hosts ?? [];
  }, [current]);

  /* ------------------------------------------------------------ what comes next, under the run */
  const actions = (() => {
    if (!current || current.status === 'running' || !pb) return null;
    const tryAgain = (
      <Button variant="outlined" startIcon={<ReplayIcon />} onClick={() => setView('form')}>
        {t('tryAgain')}
      </Button>
    );
    if (current.action === 'plan') {
      if (current.id !== lastPlan?.id) return null;
      return (
        <>
          {current.status === 'failed' ? (
            <Alert severity="warning" sx={{ flex: 1 }}>
              {t('pb.planFailed')}
            </Alert>
          ) : null}
          <Button
            variant="contained"
            color="warning"
            size="large"
            startIcon={<PlayArrowIcon />}
            disabled={running}
            onClick={() => setConfirm('run')}>
            {current.status === 'failed' ? t('pb.runAnyway') : t('pb.runIt')}
          </Button>
          {current.status === 'failed' ? (
            tryAgain
          ) : (
            <Button onClick={() => setView('form')}>{t('changeSettings')}</Button>
          )}
        </>
      );
    }
    if (current.action === 'run' && current.id === lastRun?.id && !rolledBack) {
      if (current.status === 'failed') {
        return (
          <>
            <Alert severity="error" sx={{ flex: 1 }}>
              {pb.has_rollback ? t('pb.runFailed') : t('pb.runFailedNoRb')}
            </Alert>
            {pb.has_rollback ? (
              <Button
                variant="contained"
                color="error"
                size="large"
                startIcon={<UndoIcon />}
                disabled={running || posting.isLoading}
                onClick={() => void start('rollback', current.id)}>
                {t('rollbackNow')}
              </Button>
            ) : null}
            {tryAgain}
          </>
        );
      }
      return (
        <>
          <Alert severity="success" sx={{ flex: 1 }}>
            {t('pb.runDone')}
          </Alert>
          {pb.has_rollback ? (
            <Button variant="outlined" color="error" startIcon={<UndoIcon />} onClick={() => setConfirm('rollback')}>
              {t('rollback')}
            </Button>
          ) : null}
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

  const hostResults = (current?.result ?? []).filter(isHost);
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
        {current.options?.vars && Object.keys(current.options.vars).length ? (
          <Typography variant="body2" mb={1} sx={mono}>
            {Object.entries(current.options.vars)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join('  ')}
          </Typography>
        ) : null}
        {hostResults.length ? (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                  <TableCell>{t('node')}</TableCell>
                  <TableCell>{t('result')}</TableCell>
                  <TableCell>{current.action === 'plan' ? t('pb.wouldChange') : t('pb.changed')}</TableCell>
                  <TableCell align="right">{t('pb.counts')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {hostResults.map((r) => (
                  <TableRow key={r.host}>
                    <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{r.host}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={r.status === 'failed' ? 'error' : 'success'}
                        label={t(`st_${r.status}`)}
                      />
                      {r.error ? (
                        <Typography
                          variant="caption"
                          color="error"
                          display="block"
                          mt={0.5}
                          sx={{ whiteSpace: 'pre-wrap', maxWidth: 520 }}>
                          {r.task ? `${r.task}: ` : ''}
                          {r.error.slice(0, 600)}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell sx={mono}>
                      {(r.changed ?? []).length
                        ? (r.changed ?? []).map((c) => <div key={c}>{c}</div>)
                        : t('pb.noChange')}
                    </TableCell>
                    <TableCell align="right" sx={{ ...mono, whiteSpace: 'nowrap' }}>
                      {r.stats
                        ? t('pb.countsIs', {
                            ok: r.stats.ok,
                            changed: r.stats.changed,
                            failed: r.stats.failures + r.stats.unreachable,
                            skipped: r.stats.skipped,
                          })
                        : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : null}
        {current.action === 'plan' ? (
          <Typography variant="caption" color="text.secondary" display="block" mt={1}>
            {t('pb.checkNote')}
          </Typography>
        ) : null}
      </Card>
    ) : null;

  const dialogs = (
    <>
      <PlaybookEditor
        open={editor.open}
        edit={editor.edit}
        onClose={(saved) => {
          setEditor({ open: false });
          if (saved) setPid(saved.id);
        }}
      />
      <Dialog open={!!confirm} onClose={() => setConfirm(null)}>
        <DialogTitle>{confirm === 'run' ? t('pb.confirmRunTitle') : t('confirmRollbackTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirm === 'run'
              ? t('pb.confirmRun', { name: pb?.name, where: where(lastPlan) })
              : t('pb.confirmRollback', { name: pb?.name, where: where(lastRun) })}
          </Typography>
          {defs.some((d) => d.type === 'password') || login.password ? (
            <Typography variant="caption" color="text.secondary" display="block" mt={1}>
              {t('pb.secretsAgain')}
            </Typography>
          ) : null}
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
            {confirm === 'run' ? t('pb.runIt') : t('rollback')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={pullOpen} onClose={() => setPullOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('pb.pullTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" mb={2}>
            {t('pb.pullText', {
              repo: pb?.git_url?.replace('https://', ''),
              ref: pb?.git_ref || t('pb.defaultBranch'),
            })}
          </Typography>
          <TextField
            fullWidth
            size="small"
            type="password"
            autoComplete="new-password"
            label={t('pb.gitToken')}
            value={pullToken}
            onChange={(e) => setPullToken(e.target.value)}
            helperText={t('pb.gitTokenHelp')}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPullOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            startIcon={putting.isLoading ? <CircularProgress size={16} color="inherit" /> : <SyncIcon />}
            disabled={putting.isLoading}
            onClick={() => void pullLatest()}>
            {t('pb.pullLatest')}
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={askDelete} onClose={() => setAskDelete(false)}>
        <DialogTitle>{t('pb.deleteTitle', { name: pb?.name })}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t('pb.deleteText')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAskDelete(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            color="error"
            disabled={deleting.isLoading}
            onClick={async () => {
              setAskDelete(false);
              try {
                if (pb) await del(pb.id).unwrap();
                setPid(0);
              } catch (e) {
                toast.error(errText(e, t));
              }
            }}>
            {t('pb.delete')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );

  const stepper = (
    <Card>
      <FlowStepper steps={steps} running={running} />
    </Card>
  );

  if (view === 'run' && current && pb) {
    return (
      <Stack gap={2}>
        {stepper}
        <RunView
          title={`#${current.id} ${t(`pb.a_${current.action}`)} · ${pb.name} · ${where(current)}`}
          status={current.status}
          log={log}
          knownHosts={knownHosts}
          actions={actions}
          onBack={() => setView('form')}>
          {details}
        </RunView>
        {dialogs}
      </Stack>
    );
  }

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        alignItems: 'start',
        gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: '300px minmax(0,1fr)' },
      }}>
      <Card
        title={t('pb.list')}
        action={
          <Button size="small" startIcon={<AddIcon />} onClick={() => setEditor({ open: true, edit: null })}>
            {t('pb.add')}
          </Button>
        }>
        <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
          {(playbooks.data ?? []).map((p) => (
            <Box
              key={p.id}
              onClick={() => {
                setPid(p.id);
                setSelected(0);
              }}
              sx={{
                cursor: 'pointer',
                borderRadius: 1,
                p: 0.75,
                bgcolor: p.id === pid ? 'action.selected' : undefined,
                '&:hover': { bgcolor: 'action.hover' },
              }}>
              <Typography variant="body2" fontWeight={700}>
                {p.name}
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" noWrap>
                {p.description || p.playbook_path || '—'}
              </Typography>
              <Stack direction="row" gap={0.5} mt={0.5} flexWrap="wrap">
                <Chip size="small" variant="outlined" label={t('pb.inputsN', { n: p.variables?.length ?? 0 })} />
                {p.has_rollback ? <Chip size="small" variant="outlined" label={t('pb.hasRollback')} /> : null}
                {p.git_url ? (
                  <Chip size="small" variant="outlined" icon={<GitHubIcon />} label={t('pb.github')} />
                ) : null}
              </Stack>
            </Box>
          ))}
          {!playbooks.data?.length ? (
            <Typography variant="body2" color="text.secondary">
              {t('pb.empty')}
            </Typography>
          ) : null}
        </Stack>
      </Card>

      {!pb ? (
        <Alert severity="info">{t('pb.start')}</Alert>
      ) : (
        <Stack gap={2} minWidth={0}>
          {stepper}
          <Card
            title={pb.name}
            subtitle={
              pb.git_url
                ? `${pb.description ? `${pb.description} · ` : ''}${pb.git_url.replace('https://', '')} @ ${pb.git_ref || t('pb.defaultBranch')} · ${pb.git_commit || ''}`
                : pb.description
            }
            action={
              <Stack direction="row" alignItems="center">
                {pb.git_url ? (
                  <Button size="small" startIcon={<SyncIcon />} onClick={() => setPullOpen(true)} sx={{ mr: 1 }}>
                    {t('pb.pullLatest')}
                  </Button>
                ) : null}
                <Tooltip title={t('pb.edit')}>
                  <IconButton size="small" onClick={() => setEditor({ open: true, edit: pb })}>
                    <EditIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
                <Tooltip title={t('pb.delete')}>
                  <IconButton size="small" onClick={() => setAskDelete(true)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Tooltip>
              </Stack>
            }>
            <Box sx={{ display: 'grid', gap: 2.5, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
              <Stack gap={1.5}>
                <Typography fontWeight={700} variant="body2">
                  {t('pb.machines')}
                </Typography>
                <ToggleButtonGroup
                  exclusive
                  size="small"
                  fullWidth
                  value={machines}
                  onChange={(_, v) => v && setMachines(v)}>
                  <ToggleButton value="ips">{t('pb.byIp')}</ToggleButton>
                  <ToggleButton value="cluster">{t('cluster')}</ToggleButton>
                  <ToggleButton value="inventory">{t('pb.ownInventory')}</ToggleButton>
                </ToggleButtonGroup>
                {machines === 'ips' ? (
                  <TextField
                    multiline
                    minRows={3}
                    maxRows={10}
                    label={t('pb.ips')}
                    value={ips}
                    onChange={(e) => setIps(e.target.value)}
                    placeholder={'192.168.122.24\n192.168.122.25'}
                    helperText={
                      ipsList.length
                        ? t('pb.ipsCount', { n: ipsList.length })
                        : pb.groups?.length
                          ? t('pb.ipsGroups', { list: pb.groups.map((g) => g.group).join(', ') })
                          : t('pb.ipsHelp')
                    }
                    InputProps={{ sx: mono }}
                  />
                ) : machines === 'cluster' ? (
                  <>
                    <TargetSelect value={target} onChange={setTarget} />
                    {pb.groups?.length ? (
                      <Typography variant="caption" color="text.secondary">
                        {t('pb.groupsAre')}{' '}
                        {pb.groups
                          .map((g) => `${g.group} = ${g.from === 'all' ? t('pb.allMachines') : g.from}`)
                          .join(', ')}
                      </Typography>
                    ) : null}
                    <Autocomplete
                      multiple
                      freeSolo
                      size="small"
                      options={hostOptions}
                      value={hosts}
                      onChange={(_, v) => setHosts(v)}
                      renderInput={(p) => <TextField {...p} label={t('pb.limit')} placeholder={t('pb.limitAll')} />}
                    />
                  </>
                ) : (
                  <TextField
                    multiline
                    minRows={4}
                    maxRows={12}
                    label={t('pb.inventory')}
                    value={inventory}
                    onChange={(e) => setInventory(e.target.value)}
                    placeholder={'[pgbouncer_nodes]\n10.0.0.31\n10.0.0.32'}
                    InputProps={{ sx: mono }}
                  />
                )}
                {defs.length ? (
                  <>
                    <Typography fontWeight={700} variant="body2" mt={1}>
                      {t('pb.inputs')}
                    </Typography>
                    {defs.map(input)}
                  </>
                ) : null}
              </Stack>

              <Stack gap={1.5}>
                <Typography fontWeight={700} variant="body2">
                  {t('pb.login')}
                </Typography>
                <Typography variant="caption" color="text.secondary" mt={-1}>
                  {machines === 'inventory'
                    ? t('pb.sshInventory')
                    : machines === 'cluster' && target?.kind === 'clusters'
                      ? t('sshHelp')
                      : t('sshHelpDiscovered')}
                </Typography>
                <Stack direction="row" gap={1}>
                  {field('user', t('pb.username'), { fullWidth: true, autoComplete: 'off' })}
                  {field('port', t('sshPort'), { sx: { width: 90, flexShrink: 0 } })}
                </Stack>
                {field('password', t('pb.password'), { type: 'password', autoComplete: 'new-password' })}
                <Accordion
                  disableGutters
                  variant="outlined"
                  sx={{ borderRadius: 1.5, '&:before': { display: 'none' } }}>
                  <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                    <Typography variant="body2" fontWeight={700}>
                      {t('pb.more')}
                    </Typography>
                  </AccordionSummary>
                  <AccordionDetails>
                    <Stack gap={1.5}>
                      {field('key', t('sshKey'), { multiline: true, minRows: 2, maxRows: 5, InputProps: { sx: mono } })}
                      {field('become', t('pb.become'), { type: 'password', autoComplete: 'new-password' })}
                      {field('vault', t('pb.vault'), { type: 'password', autoComplete: 'new-password' })}
                      <TextField
                        multiline
                        minRows={3}
                        maxRows={10}
                        label={t('pb.extraVars')}
                        value={extraVars}
                        onChange={(e) => setExtraVars(e.target.value)}
                        placeholder={'pg_version: 16\nrestart: true'}
                        InputProps={{ sx: mono }}
                      />
                      <FormControlLabel
                        control={
                          <Checkbox size="small" checked={verbose} onChange={(e) => setVerbose(e.target.checked)} />
                        }
                        label={<Typography variant="body2">{t('pb.verbose')}</Typography>}
                      />
                    </Stack>
                  </AccordionDetails>
                </Accordion>
                <Button
                  variant="contained"
                  size="large"
                  startIcon={posting.isLoading ? <CircularProgress size={18} color="inherit" /> : <FactCheckIcon />}
                  disabled={posting.isLoading || running || noMachines || needLogin || missing.length > 0}
                  onClick={() => void start('plan')}>
                  {t('dryRun')}
                </Button>
                {missing.length ? (
                  <Typography variant="caption" color="warning.main">
                    {t('pb.fill', { list: missing.map((d) => d.label || d.name).join(', ') })}
                  </Typography>
                ) : null}
                {running ? <Alert severity="info">{t('pb.busy')}</Alert> : null}
              </Stack>
            </Box>
          </Card>

          <Card title={t('history')}>
            <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
              {list.map((r) => (
                <Stack
                  key={r.id}
                  direction="row"
                  alignItems="center"
                  gap={1}
                  py={0.75}
                  px={0.75}
                  sx={{ cursor: 'pointer', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
                  onClick={() => {
                    setSelected(r.id);
                    setView('run');
                  }}>
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" fontWeight={700}>
                      #{r.id} {t(`pb.a_${r.action}`)} · {where(r)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>
                      {new Date(r.created_at).toLocaleString()} · {r.created_by || '—'}
                    </Typography>
                  </Box>
                  <Chip size="small" color={STATUS[r.status]} label={t(`st_${r.status}`)} sx={{ fontWeight: 700 }} />
                </Stack>
              ))}
              {!list.length ? (
                <Typography variant="body2" color="text.secondary">
                  {t('pb.noRuns')}
                </Typography>
              ) : null}
            </Stack>
          </Card>
        </Stack>
      )}
      {dialogs}
    </Box>
  );
};

export default CustomPlaybooks;
