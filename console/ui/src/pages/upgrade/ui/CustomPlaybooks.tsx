import { FC, useEffect, useMemo, useRef, useState } from 'react';
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
  Step,
  StepLabel,
  Stepper,
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
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { useGetDiscoveriesQuery, useGetDiscoveryQuery } from '@shared/api/api/discover.ts';
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
} from '@shared/api/api/playbooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { can } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import Card from '@pages/discover/ui/Card.tsx';
import PlaybookEditor from './PlaybookEditor.tsx';

const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };
const STATUS = { running: 'info', success: 'success', failed: 'error' } as const;
const isHost = (r: unknown): r is PHostResult => !!r && typeof r === 'object' && 'host' in r;
const errText = (e: unknown, t: (k: string) => string) =>
  String((e as { data?: { title?: string } }).data?.title ?? t('failed'));

type Machines = 'discovery' | 'cluster' | 'inventory';

/** pg_mantra Upgrades > Custom playbooks: your own upgrade + rollback playbooks, with the inputs they need, run by
 * the console in the upgrade runner container: dry run (--check --diff), upgrade, rollback. */
const CustomPlaybooks: FC = () => {
  const { t } = useTranslation('upgrade');
  const user = useSessionUser();
  const playbooks = useGetPlaybooksQuery();
  const [pid, setPid] = useState(0);
  const pb: Playbook | undefined = playbooks.data?.find((p) => p.id === pid);
  const [editor, setEditor] = useState<{ open: boolean; edit?: Playbook | null }>({ open: false });
  const [del, deleting] = useDeletePlaybookMutation();
  const [askDelete, setAskDelete] = useState(false);
  useEffect(() => {
    if (!pb && playbooks.data?.length) setPid(playbooks.data[0].id);
  }, [pb, playbooks.data]);

  // the machines
  const projectId = Number(useAppSelector(selectCurrentProject));
  const clusters = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const allowed = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && can('upgrade.run', c.id, user)),
    [clusters.data, user],
  );
  const discoveries = useGetDiscoveriesQuery();
  const [machines, setMachines] = useState<Machines>('discovery');
  const [discoveryId, setDiscoveryId] = useState(0);
  const [clusterId, setClusterId] = useState(0);
  const [inventory, setInventory] = useState('');
  const [hosts, setHosts] = useState<string[]>([]);
  const discovery = useGetDiscoveryQuery(discoveryId, { skip: machines !== 'discovery' || !discoveryId });
  const hostOptions = useMemo(
    () => (discovery.data?.result.infra?.hosts ?? []).map((h) => h.address),
    [discovery.data],
  );
  useEffect(() => {
    if (!discoveryId && discoveries.data?.[0]) setDiscoveryId(discoveries.data[0].id);
    if (!clusterId && allowed[0]?.id) setClusterId(allowed[0].id);
  }, [discoveries.data, allowed, discoveryId, clusterId]);

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
  const [running, setRunning] = useState(false);
  const runs = useGetPlaybookRunsQuery(pid, { skip: !pid, pollingInterval: running ? 4000 : 0 });
  useEffect(() => setRunning((runs.data ?? []).some((r) => r.status === 'running')), [runs.data]);
  const list = runs.data ?? [];
  const current: PlaybookRun | undefined = list.find((r) => r.id === selected) ?? list[0];
  const detail = useGetPlaybookRunQuery(
    { id: pid, uid: current?.id ?? 0 },
    { skip: !current?.id, pollingInterval: current?.status === 'running' ? 3000 : 0 },
  );
  const logText = (detail.data?.id === current?.id ? detail.data?.log : '')?.slice(-30000) ?? '';
  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    // follow the end of the log
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logText]);
  const lastPlan = list.find((r) => r.action === 'plan');
  const lastRun = list.find((r) => r.action === 'run');
  const rolledBack = lastRun && list.some((r) => r.action === 'rollback' && r.parent_id === lastRun.id);
  const step = !lastPlan ? 0 : !lastRun || lastPlan.id > lastRun.id ? 1 : rolledBack ? 3 : 2;
  const [confirm, setConfirm] = useState<null | 'run' | 'rollback'>(null);
  const [post, posting] = usePostPlaybookRunMutation();

  const missing = defs.filter(
    (d) => d.required && d.type !== 'boolean' && (vals[d.name] === '' || vals[d.name] == null),
  );
  const noMachines =
    (machines === 'discovery' && !discoveryId) ||
    (machines === 'cluster' && !clusterId) ||
    (machines === 'inventory' && !inventory.trim());
  const needLogin = machines === 'discovery' && !login.user.trim();

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
      // the dry run fixes the machines and the inputs; the upgrade and the rollback reuse them
      body.discovery_id = machines === 'discovery' ? discoveryId : undefined;
      body.cluster_id = machines === 'cluster' ? clusterId : undefined;
      body.inventory = machines === 'inventory' ? inventory : undefined;
      body.hosts = hosts.length ? hosts : undefined;
      body.vars = vals;
      body.extra_vars = extraVars.trim() || undefined;
    } else {
      body.vars = Object.fromEntries(defs.filter((d) => d.type === 'password').map((d) => [d.name, vals[d.name]]));
    }
    try {
      const out = await post({ id: pb.id, body }).unwrap();
      setSelected(out.id);
      setRunning(true);
      toast.success(t(`started_${action}`));
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

  const hostResults = (current?.result ?? []).filter(isHost);
  const where = (r?: PlaybookRun) => {
    const o = r?.options;
    if (!o) return '';
    if (o.discovery_id) return `${t('kindDiscovered')} #${o.discovery_id}`;
    if (o.cluster_id) return `${t('cluster')} ${allowed.find((c) => c.id === o.cluster_id)?.name ?? o.cluster_id}`;
    return t('pb.ownInventory');
  };

  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        alignItems: 'start',
        gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: '320px minmax(0,1fr)' },
      }}>
      <Stack gap={2}>
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
                <Stack direction="row" gap={0.5} mt={0.5}>
                  <Chip size="small" variant="outlined" label={t('pb.inputsN', { n: p.variables?.length ?? 0 })} />
                  {p.has_rollback ? <Chip size="small" variant="outlined" label={t('pb.hasRollback')} /> : null}
                  {p.files_name ? <Chip size="small" variant="outlined" label={p.files_name} /> : null}
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

        {pb ? (
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
                  sx={{
                    cursor: 'pointer',
                    borderRadius: 1,
                    bgcolor: current?.id === r.id ? 'action.selected' : undefined,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                  onClick={() => setSelected(r.id)}>
                  <Box flex={1} minWidth={0}>
                    <Typography variant="body2" fontWeight={700}>
                      #{r.id} {t(`a_${r.action}`)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap>
                      {new Date(r.created_at).toLocaleString()} · {r.created_by || '—'} · {where(r)}
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
        ) : null}
      </Stack>

      {!pb ? (
        <Alert severity="info">{t('pb.start')}</Alert>
      ) : (
        <Stack gap={2} minWidth={0}>
          <Card
            title={pb.name}
            action={
              <Stack direction="row">
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
            {pb.description ? (
              <Typography variant="body2" color="text.secondary" mb={1.5}>
                {pb.description}
              </Typography>
            ) : null}
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
                  <ToggleButton value="discovery">{t('kindDiscovered')}</ToggleButton>
                  <ToggleButton value="cluster">{t('kindCluster')}</ToggleButton>
                  <ToggleButton value="inventory">{t('pb.ownInventory')}</ToggleButton>
                </ToggleButtonGroup>
                {machines === 'discovery' ? (
                  <TextField
                    select
                    size="small"
                    label={t('setup')}
                    value={discoveryId || ''}
                    helperText={!discoveries.data?.length ? t('noDiscoveries') : undefined}
                    onChange={(e) => setDiscoveryId(Number(e.target.value))}>
                    {(discoveries.data ?? []).map((d) => (
                      <MenuItem key={d.id} value={d.id}>
                        #{d.id} {d.name}
                      </MenuItem>
                    ))}
                  </TextField>
                ) : machines === 'cluster' ? (
                  <TextField
                    select
                    size="small"
                    label={t('cluster')}
                    value={clusterId || ''}
                    onChange={(e) => setClusterId(Number(e.target.value))}>
                    {allowed.map((c) => (
                      <MenuItem key={c.id} value={c.id}>
                        {c.name}
                      </MenuItem>
                    ))}
                  </TextField>
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
                {pb.groups?.length && machines !== 'inventory' ? (
                  <Typography variant="caption" color="text.secondary">
                    {t('pb.groupsAre')}{' '}
                    {pb.groups.map((g) => `${g.group} = ${g.from === 'all' ? t('pb.allMachines') : g.from}`).join(', ')}
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
                  {machines === 'cluster'
                    ? t('sshHelp')
                    : machines === 'inventory'
                      ? t('pb.sshInventory')
                      : t('sshHelpDiscovered')}
                </Typography>
                <Stack direction="row" gap={1}>
                  {field('user', t('sshUser'), { fullWidth: true, autoComplete: 'off' })}
                  {field('port', t('sshPort'), { sx: { width: 90, flexShrink: 0 } })}
                </Stack>
                {field('password', t('sshPassword'), { type: 'password', autoComplete: 'new-password' })}
                {field('key', t('sshKey'), { multiline: true, minRows: 2, maxRows: 5, InputProps: { sx: mono } })}
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

          <Card>
            <Stepper activeStep={step} alternativeLabel>
              {['s1', 's2', 's3', 's4'].map((s) => (
                <Step key={s}>
                  <StepLabel>{t(s)}</StepLabel>
                </Step>
              ))}
            </Stepper>
          </Card>

          {current ? (
            <Card
              title={`#${current.id} ${t(`a_${current.action}`)} · ${where(current)}`}
              action={
                <Chip color={STATUS[current.status]} label={t(`st_${current.status}`)} sx={{ fontWeight: 700 }} />
              }>
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
                              : current.status !== 'running'
                                ? t('pb.noChange')
                                : ''}
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
              {current.action === 'plan' && current.status !== 'running' ? (
                <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                  {t('pb.checkNote')}
                </Typography>
              ) : null}

              {current.action === 'plan' && current.status !== 'running' && current.id === lastPlan?.id ? (
                <Stack direction="row" gap={2} alignItems="center" mt={2} flexWrap="wrap">
                  <Button
                    variant="contained"
                    color="warning"
                    startIcon={<PlayArrowIcon />}
                    disabled={running}
                    onClick={() => setConfirm('run')}>
                    {t('proceed')}
                  </Button>
                  {current.status === 'failed' ? (
                    <Typography variant="caption" color="warning.main">
                      {t('pb.planFailed')}
                    </Typography>
                  ) : null}
                </Stack>
              ) : null}
              {current.action === 'run' && current.status !== 'running' && current.id === lastRun?.id && !rolledBack ? (
                <Stack direction="row" gap={2} alignItems="center" mt={2} flexWrap="wrap">
                  <Button
                    variant="outlined"
                    color="error"
                    startIcon={<UndoIcon />}
                    disabled={running || !pb.has_rollback}
                    onClick={() => setConfirm('rollback')}>
                    {t('rollback')}
                  </Button>
                  {!pb.has_rollback ? (
                    <Typography variant="caption" color="text.secondary">
                      {t('pb.noRollback')}
                    </Typography>
                  ) : null}
                </Stack>
              ) : null}

              <Box mt={2}>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('log')}
                </Typography>
                <Box
                  component="pre"
                  ref={logRef}
                  sx={{
                    ...mono,
                    fontSize: 11.5,
                    m: 0,
                    p: 1.25,
                    bgcolor: 'action.hover',
                    borderRadius: 1.5,
                    maxHeight: 380,
                    overflow: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}>
                  {logText || t('noLog')}
                </Box>
              </Box>
            </Card>
          ) : null}
        </Stack>
      )}

      <PlaybookEditor
        open={editor.open}
        edit={editor.edit}
        onClose={(saved) => {
          setEditor({ open: false });
          if (saved) setPid(saved.id);
        }}
      />

      <Dialog open={!!confirm} onClose={() => setConfirm(null)}>
        <DialogTitle>{confirm === 'run' ? t('confirmRunTitle') : t('confirmRollbackTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirm === 'run'
              ? t('pb.confirmRun', { name: pb?.name, where: where(lastPlan) })
              : t('pb.confirmRollback', { name: pb?.name, where: where(lastRun) })}
          </Typography>
          {defs.some((d) => d.type === 'password') || !login.user.trim() ? (
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
            {confirm === 'run' ? t('proceed') : t('rollback')}
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
    </Box>
  );
};

export default CustomPlaybooks;
