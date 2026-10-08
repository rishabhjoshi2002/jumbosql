import { FC, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  FormControlLabel,
  GlobalStyles,
  IconButton,
  MenuItem,
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
  Tooltip,
  Typography,
} from '@mui/material';
import TravelExploreIcon from '@mui/icons-material/TravelExploreOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import ReplayIcon from '@mui/icons-material/Replay';
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  Discovery,
  useDeleteDiscoveryMutation,
  useGetDiscoveriesQuery,
  useLazyGetDiscoveryQuery,
  usePostDiscoverMutation,
} from '@shared/api/api/discover.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import Topology, { roleKey, useRoleColors } from './Topology.tsx';
import NodeDetails from './NodeDetails.tsx';
import DatabaseExplorer, { CHECK_ICON, dbStatus } from './DatabaseExplorer.tsx';
import QueryRunner from './QueryRunner.tsx';

const Card: FC<{ title?: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }> = ({
  title,
  subtitle,
  children,
  action,
}) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper', minWidth: 0 }}>
    {title ? (
      <Stack direction="row" alignItems="flex-start" gap={1} mb={1.25}>
        <Box flex={1}>
          <Typography fontWeight={700}>{title}</Typography>
          {subtitle ? (
            <Typography variant="caption" color="text.secondary">
              {subtitle}
            </Typography>
          ) : null}
        </Box>
        {action}
      </Stack>
    ) : null}
    {children}
  </Box>
);

const SEV = {
  critical: <ErrorOutlineIcon fontSize="small" color="error" />,
  warning: <WarningAmberIcon fontSize="small" color="warning" />,
  info: <InfoOutlinedIcon fontSize="small" color="info" />,
};

const countLines = (s: string) => s.split('\n').filter((l) => l.replace(/#.*/, '').trim()).length;

/** pg_genin Discover: point at any PostgreSQL servers, get the architecture and every detail. */
const Discover: FC = () => {
  const { t } = useTranslation('discover');
  const colors = useRoleColors();
  const [form, setForm] = useState({
    inventory: '',
    username: '',
    password: '',
    database: 'postgres',
    sslmode: 'prefer',
    name: '',
    save: true,
  });
  const [current, setCurrent] = useState<Discovery | null>(null);
  const [selected, setSelected] = useState<string>('');
  const [view, setView] = useState<'architecture' | 'databases' | 'query'>('architecture');
  const [dbServer, setDbServer] = useState('');
  const [dbName, setDbName] = useState('');
  const [run, running] = usePostDiscoverMutation();
  const saved = useGetDiscoveriesQuery();
  const [load, loading] = useLazyGetDiscoveryQuery();
  const [remove] = useDeleteDiscoveryMutation();
  const res = current?.result;
  const node = res?.nodes.find((n) => n.id === selected) ?? res?.nodes[0];

  useEffect(() => {
    if (res) setDbServer(res.nodes.find((n) => n.reachable && n.role !== 'standby')?.id ?? '');
    if (res) setSelected(res.nodes.find((n) => n.role === 'primary')?.id ?? res.nodes[0]?.id ?? '');
  }, [res]);

  const set = (k: keyof typeof form, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));
  const submit = async () => {
    try {
      const out = await run({ ...form, name: form.name.trim() || undefined }).unwrap();
      setCurrent(out);
      if (form.save) toast.success(t('saved'));
    } catch (e) {
      toast.error(String((e as { data?: { description?: string; title?: string } }).data?.title ?? t('failed')));
    }
  };
  const open = async (id: number) => {
    try {
      setCurrent(await load(id).unwrap());
    } catch {
      toast.error(t('failed'));
    }
  };
  const again = (d: { inventory: string; username: string; name: string }) => {
    setForm((f) => ({ ...f, inventory: d.inventory, username: d.username, name: d.name, password: '' }));
    toast.info(t('enterPassword'));
  };
  const download = () => {
    if (!current) return;
    const blob = new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `discover-${(current.name || 'result').replace(/[^\w.-]+/g, '_')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const n = countLines(form.inventory);
  // databases to review: writable servers (a standby holds the same data as its primary)
  const readinessRows = (res?.nodes ?? [])
    .filter((x) => x.reachable && !x.external && x.role !== 'standby')
    .flatMap((x) =>
      (x.databases ?? [])
        .filter((d) => d.name !== 'postgres' || (d.inventory?.counts.tables ?? 0) > 0)
        .map((d) => ({ n: x, d })),
    );
  const dbNode =
    res?.nodes.find((x) => x.id === dbServer && x.reachable) ?? res?.nodes.find((x) => x.reachable && !x.external);

  return (
    <Stack gap={2} p={2}>
      <GlobalStyles
        styles={{
          '@media print': {
            '[data-print-hide], header, nav, .MuiDrawer-root': { display: 'none !important' },
            body: { background: '#fff !important' },
          },
        }}
      />
      <Box>
        <Typography variant="h6">{t('title')}</Typography>
        <Typography variant="body2" color="text.secondary" maxWidth={980}>
          {t('help')}
        </Typography>
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          alignItems: 'start',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: '360px minmax(0, 1fr)' },
        }}>
        {/* left: what to look at */}
        <Stack gap={2} data-print-hide>
          <Card title={t('newTitle')} subtitle={t('newHelp')}>
            <Stack gap={1.5}>
              <TextField
                label={t('inventory')}
                multiline
                minRows={5}
                maxRows={14}
                value={form.inventory}
                onChange={(e) => set('inventory', e.target.value)}
                placeholder={'10.0.0.11\n10.0.0.12:5432\n10.0.0.13 5433'}
                helperText={t('inventoryHelp', { count: n })}
                InputProps={{ sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 13 } }}
              />
              <Stack direction="row" gap={1}>
                <TextField
                  label={t('username')}
                  size="small"
                  fullWidth
                  value={form.username}
                  onChange={(e) => set('username', e.target.value)}
                  autoComplete="off"
                />
                <TextField
                  label={t('password')}
                  size="small"
                  type="password"
                  fullWidth
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  autoComplete="new-password"
                />
              </Stack>
              <Stack direction="row" gap={1}>
                <TextField
                  label={t('database')}
                  size="small"
                  fullWidth
                  value={form.database}
                  onChange={(e) => set('database', e.target.value)}
                />
                <TextField
                  select
                  label={t('ssl')}
                  size="small"
                  fullWidth
                  value={form.sslmode}
                  onChange={(e) => set('sslmode', e.target.value)}>
                  {['prefer', 'require', 'disable'].map((m) => (
                    <MenuItem key={m} value={m}>
                      {m}
                    </MenuItem>
                  ))}
                </TextField>
              </Stack>
              <TextField
                label={t('name')}
                size="small"
                value={form.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('namePlaceholder')}
              />
              <FormControlLabel
                control={<Checkbox checked={form.save} onChange={(e) => set('save', e.target.checked)} />}
                label={<Typography variant="body2">{t('save')}</Typography>}
              />
              <Button
                variant="contained"
                size="large"
                startIcon={running.isLoading ? <CircularProgress size={18} color="inherit" /> : <TravelExploreIcon />}
                disabled={running.isLoading || !n || !form.username.trim()}
                onClick={() => void submit()}>
                {running.isLoading ? t('running', { count: n }) : t('run')}
              </Button>
              <Typography variant="caption" color="text.secondary">
                {t('readOnlyNote')}
              </Typography>
            </Stack>
          </Card>

          <Card title={t('savedTitle')}>
            <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
              {(saved.data ?? []).map((d) => (
                <Stack
                  key={d.id}
                  direction="row"
                  alignItems="center"
                  gap={0.5}
                  py={0.75}
                  sx={{
                    cursor: 'pointer',
                    borderRadius: 1,
                    bgcolor: current?.id === d.id ? 'action.selected' : undefined,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                  onClick={() => void open(d.id)}>
                  <Box flex={1} minWidth={0} px={0.75}>
                    <Typography variant="body2" fontWeight={700} noWrap>
                      {d.name}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="div" noWrap>
                      {d.architecture}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="div" noWrap>
                      {t('savedLine', {
                        count: countLines(d.inventory),
                        date: new Date(d.created_at).toLocaleString(),
                        by: d.created_by || '—',
                      })}
                    </Typography>
                  </Box>
                  <Tooltip title={t('runAgain')}>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        again(d);
                      }}>
                      <ReplayIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                  <Tooltip title={t('delete')}>
                    <IconButton
                      size="small"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(t('deleteConfirm', { name: d.name }))) {
                          void remove(d.id);
                          if (current?.id === d.id) setCurrent(null);
                        }
                      }}>
                      <DeleteOutline fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Stack>
              ))}
              {!saved.data?.length ? (
                <Typography variant="body2" color="text.secondary">
                  {t('noSaved')}
                </Typography>
              ) : null}
            </Stack>
          </Card>
        </Stack>

        {/* right: the result */}
        <Stack gap={2} minWidth={0}>
          {loading.isFetching ? <Alert severity="info">{t('loading')}</Alert> : null}
          {!res && !loading.isFetching ? (
            <Box
              sx={{
                border: 1,
                borderStyle: 'dashed',
                borderColor: 'divider',
                borderRadius: 2,
                p: 5,
                textAlign: 'center',
                color: 'text.secondary',
              }}>
              <TravelExploreIcon sx={{ fontSize: 48, opacity: 0.5 }} />
              <Typography fontWeight={700} mt={1}>
                {t('emptyTitle')}
              </Typography>
              <Typography variant="body2" maxWidth={560} mx="auto">
                {t('emptyHelp')}
              </Typography>
            </Box>
          ) : null}
          {res && current ? (
            <>
              {/* headline */}
              <Card>
                <Stack direction="row" alignItems="flex-start" gap={2} flexWrap="wrap">
                  <Box flex={1} minWidth={260}>
                    <Typography variant="caption" color="text.secondary">
                      {current.name} · {new Date(res.at).toLocaleString()}
                      {current.created_by ? ` · ${current.created_by}` : ''} ·{' '}
                      {t('loginAs', { user: current.username })}
                    </Typography>
                    <Typography variant="h5" fontWeight={800} mt={0.25}>
                      {res.architecture}
                    </Typography>
                  </Box>
                  <Stack direction="row" gap={0.5} data-print-hide>
                    <Tooltip title={t('runAgain')}>
                      <IconButton onClick={() => again(current)}>
                        <ReplayIcon />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t('download')}>
                      <IconButton onClick={download}>
                        <DownloadOutlined />
                      </IconButton>
                    </Tooltip>
                    <Tooltip title={t('print')}>
                      <IconButton onClick={() => window.print()}>
                        <PrintOutlinedIcon />
                      </IconButton>
                    </Tooltip>
                  </Stack>
                </Stack>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 1.5,
                    mt: 1.5,
                    gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(3, 1fr)', xl: 'repeat(6, 1fr)' },
                  }}>
                  {[
                    [t('k_servers'), `${res.counts.reachable} / ${res.counts.nodes}`, t('k_reachable')],
                    [t('k_primaries'), String(res.counts.primaries), t('k_writable')],
                    [t('k_standbys'), String(res.counts.standbys), t('k_streaming')],
                    [t('k_subscribers'), String(res.counts.subscribers), t('k_logical')],
                    [t('k_databases'), String(res.counts.databases), t('k_userDbs')],
                    [t('k_size'), bytes(res.counts.size_bytes), t('k_sizeHelp')],
                  ].map(([label, value, sub]) => (
                    <Box key={label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1 }}>
                      <Typography variant="caption" color="text.secondary">
                        {label}
                      </Typography>
                      <Typography sx={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{value}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {sub}
                      </Typography>
                    </Box>
                  ))}
                </Box>
                <Stack component="ul" gap={0.5} sx={{ m: 0, mt: 1.5, pl: 2.5 }}>
                  {res.summary.map((s) => (
                    <Typography component="li" variant="body2" key={s}>
                      {s}
                    </Typography>
                  ))}
                </Stack>
              </Card>

              <Tabs
                value={view}
                onChange={(_, v) => setView(v)}
                data-print-hide
                sx={{
                  borderBottom: 1,
                  borderColor: 'divider',
                  minHeight: 44,
                  '& .MuiTab-root': { minHeight: 44, fontWeight: 600 },
                }}>
                <Tab value="architecture" label={t('v_architecture')} />
                <Tab value="databases" label={t('v_databases')} />
                <Tab value="query" label={t('v_query')} />
              </Tabs>

              {view === 'architecture' ? (
                <>
                  <Card title={t('diagramTitle')} subtitle={t('diagramHelp')}>
                    <Topology result={res} selected={node?.id} onSelect={setSelected} />
                  </Card>

                  {res.findings.length ? (
                    <Card title={t('findingsTitle')} subtitle={t('findingsHelp')}>
                      <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
                        {res.findings.map((f, i) => (
                          <Stack
                            key={i}
                            direction="row"
                            gap={1.25}
                            py={0.75}
                            sx={{ cursor: f.node ? 'pointer' : undefined }}
                            onClick={() => f.node && setSelected(f.node)}>
                            <Box sx={{ pt: '1px' }}>{SEV[f.severity]}</Box>
                            <Typography variant="body2">{f.text}</Typography>
                          </Stack>
                        ))}
                      </Stack>
                    </Card>
                  ) : (
                    <Alert severity="success">{t('noFindings')}</Alert>
                  )}

                  <Card title={t('serversTitle')}>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            <TableCell>{t('c_server')}</TableCell>
                            <TableCell>{t('c_role')}</TableCell>
                            <TableCell>{t('c_version')}</TableCell>
                            <TableCell align="right">{t('c_databases')}</TableCell>
                            <TableCell align="right">{t('c_size')}</TableCell>
                            <TableCell align="right">{t('c_connections')}</TableCell>
                            <TableCell>{t('c_stack')}</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {res.nodes.map((x) => {
                            const k = roleKey(x);
                            const conns = Object.values(x.connections ?? {}).reduce((s, v) => s + v, 0);
                            return (
                              <TableRow
                                key={x.id}
                                hover
                                selected={x.id === node?.id}
                                onClick={() => setSelected(x.id)}
                                sx={{ cursor: 'pointer', '& td': { whiteSpace: 'nowrap' } }}>
                                <TableCell>
                                  <Typography variant="body2" fontWeight={700}>
                                    {x.name || x.host}
                                  </Typography>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                                    {x.host}
                                    {x.port ? `:${x.port}` : ''}
                                  </Typography>
                                </TableCell>
                                <TableCell>
                                  <Chip
                                    size="small"
                                    label={t(`role_${k}`)}
                                    sx={{
                                      bgcolor: colors[k as keyof typeof colors] ?? colors.unknown,
                                      color: '#fff',
                                      fontWeight: 700,
                                      height: 22,
                                    }}
                                  />
                                </TableCell>
                                <TableCell
                                  title={x.error}
                                  sx={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                  {x.version ?? (x.reachable ? '' : x.error)}
                                </TableCell>
                                <TableCell align="right">{x.databases?.length ?? '—'}</TableCell>
                                <TableCell align="right">
                                  {x.databases ? bytes(x.databases.reduce((s, d) => s + d.size_bytes, 0)) : '—'}
                                </TableCell>
                                <TableCell align="right">
                                  {x.reachable ? `${conns} / ${x.max_connections ?? '—'}` : '—'}
                                </TableCell>
                                <TableCell>{(x.stack ?? []).join(', ')}</TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Card>

                  {node ? <NodeDetails key={node.id} node={node} result={res} /> : null}
                </>
              ) : null}

              {view === 'databases' ? (
                <>
                  <Card title={t('readinessTitle')} subtitle={t('readinessHelp')}>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                            <TableCell>{t('c_server')}</TableCell>
                            <TableCell>{t('database')}</TableCell>
                            <TableCell align="right">{t('c_size')}</TableCell>
                            <TableCell align="right">{t('k_tables')}</TableCell>
                            <TableCell align="right">{t('k_indexes')}</TableCell>
                            <TableCell align="right">{t('c_noPk')}</TableCell>
                            <TableCell align="right">{t('c_unlogged')}</TableCell>
                            <TableCell align="right">{t('c_lo')}</TableCell>
                            <TableCell>{t('t_extensions')}</TableCell>
                            <TableCell>{t('c_status')}</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {readinessRows.map(({ n, d }) => {
                            const c = d.inventory?.counts ?? {};
                            const st = dbStatus(d.inventory);
                            const issues = (d.inventory?.checks ?? []).filter(
                              (x) => x.status === 'critical' || x.status === 'warning',
                            ).length;
                            return (
                              <TableRow
                                key={`${n.id}/${d.name}`}
                                hover
                                selected={dbServer === n.id && dbName === d.name}
                                onClick={() => {
                                  setDbServer(n.id);
                                  setDbName(d.name);
                                }}
                                sx={{ cursor: 'pointer', '& td': { whiteSpace: 'nowrap' } }}>
                                <TableCell>
                                  <b>{n.name}</b>{' '}
                                  <Typography component="span" variant="caption" color="text.secondary">
                                    {t(`role_${n.role}`)}
                                  </Typography>
                                </TableCell>
                                <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                                <TableCell align="right">{bytes(d.size_bytes)}</TableCell>
                                <TableCell align="right">{c.tables ?? d.tables}</TableCell>
                                <TableCell align="right">{c.indexes ?? '—'}</TableCell>
                                <TableCell
                                  align="right"
                                  sx={{
                                    color: c.tables_without_primary_key ? 'error.main' : undefined,
                                    fontWeight: c.tables_without_primary_key ? 700 : undefined,
                                  }}>
                                  {c.tables_without_primary_key ?? '—'}
                                </TableCell>
                                <TableCell align="right">{c.unlogged_tables ?? '—'}</TableCell>
                                <TableCell align="right">{c.large_objects ?? '—'}</TableCell>
                                <TableCell
                                  sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}
                                  title={(d.extensions ?? []).join(', ')}>
                                  {(d.extensions ?? []).map((e) => e.split(' ')[0]).join(', ') || '—'}
                                </TableCell>
                                <TableCell>
                                  <Stack direction="row" gap={0.75} alignItems="center">
                                    {d.inventory ? CHECK_ICON[st] : null}
                                    <Typography variant="body2">
                                      {!d.inventory
                                        ? t('notRead')
                                        : issues
                                          ? t('issues', { count: issues })
                                          : t('ready')}
                                    </Typography>
                                  </Stack>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Card>
                  {dbNode ? (
                    <Card
                      title={t('explorerTitle', { server: dbNode.name })}
                      subtitle={t('explorerHelp')}
                      action={
                        <TextField
                          select
                          size="small"
                          label={t('server')}
                          value={dbNode.id}
                          onChange={(e) => {
                            setDbServer(e.target.value);
                            setDbName('');
                          }}
                          sx={{ minWidth: 220 }}>
                          {res.nodes
                            .filter((x) => x.reachable && !x.external)
                            .map((x) => (
                              <MenuItem key={x.id} value={x.id}>
                                {x.name} · {t(`role_${x.role}`)}
                              </MenuItem>
                            ))}
                        </TextField>
                      }>
                      <DatabaseExplorer key={dbNode.id} node={dbNode} db={dbName || undefined} onDb={setDbName} />
                    </Card>
                  ) : null}
                </>
              ) : null}

              {view === 'query' ? (
                <Card title={t('queryTitle')} subtitle={t('queryHelp')}>
                  <QueryRunner
                    result={res}
                    username={current.username}
                    password={form.password}
                    sslmode={form.sslmode}
                    onPassword={(p) => set('password', p)}
                    server={selected}
                  />
                </Card>
              ) : null}
            </>
          ) : null}
        </Stack>
      </Box>
    </Stack>
  );
};

export default Discover;
