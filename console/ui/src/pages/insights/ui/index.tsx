import { FC, ReactNode, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'react-toastify';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { InsightsReport, InsightsTable, Recommendation, useGetInsightsQuery } from '@shared/api/api/insights.ts';
import { can } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import TrendChart, { ChartSeries } from './TrendChart.tsx';
import { bytes, compact, cpuPct, daysText, ms, pct, signed, suggestedCores } from '../lib/format.ts';

const Card: FC<{ title: string; subtitle?: ReactNode; children: ReactNode; action?: ReactNode }> = ({
  title,
  subtitle,
  children,
  action,
}) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper', minWidth: 0 }}>
    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} mb={1}>
      <Box>
        <Typography fontWeight={700}>{title}</Typography>
        {subtitle ? (
          <Typography variant="caption" color="text.secondary" component="div">
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      {action}
    </Stack>
    {children}
  </Box>
);

const Stat: FC<{ label: string; value: string; sub?: ReactNode; tone?: 'critical' | 'warning' }> = ({
  label,
  value,
  sub,
  tone,
}) => (
  <Box
    sx={{
      border: 1,
      borderColor: tone === 'critical' ? 'error.main' : tone === 'warning' ? 'warning.main' : 'divider',
      borderRadius: 2,
      p: 2,
      bgcolor: 'background.paper',
      minWidth: 0,
    }}>
    <Typography variant="body2" color="text.secondary" noWrap>
      {label}
    </Typography>
    <Typography sx={{ fontSize: 28, fontWeight: 650, lineHeight: 1.25, my: 0.25 }} noWrap>
      {value}
    </Typography>
    <Typography variant="caption" color="text.secondary" component="div" sx={{ minHeight: 18 }}>
      {sub}
    </Typography>
  </Box>
);

const SEVERITY: Record<Recommendation['severity'], { icon: ReactNode; color: 'error' | 'warning' | 'info' }> = {
  critical: { icon: <ErrorOutlineIcon fontSize="small" />, color: 'error' },
  warning: { icon: <WarningAmberIcon fontSize="small" />, color: 'warning' },
  info: { icon: <InfoOutlinedIcon fontSize="small" />, color: 'info' },
};

const Recommendations: FC<{ items: Recommendation[] }> = ({ items }) => {
  const { t } = useTranslation('insights');
  const [filter, setFilter] = useState<string>('all');
  const counts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, warning: 0, info: 0 };
    items.forEach((r) => (c[r.severity] += 1));
    return c;
  }, [items]);
  const shown = items.filter((r) => filter === 'all' || r.severity === filter);
  return (
    <Card
      title={t('recommendations')}
      subtitle={t('recommendationsHelp')}
      action={
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="all">{t('all')}</ToggleButton>
          <ToggleButton value="critical">
            {t('critical')} ({counts.critical})
          </ToggleButton>
          <ToggleButton value="warning">
            {t('warning')} ({counts.warning})
          </ToggleButton>
          <ToggleButton value="info">
            {t('info')} ({counts.info})
          </ToggleButton>
        </ToggleButtonGroup>
      }>
      {!items.length ? (
        <Alert severity="success">{t('noRecommendations')}</Alert>
      ) : (
        <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
          {shown.map((r, i) => {
            const s = SEVERITY[r.severity];
            return (
              <Stack key={i} direction="row" gap={1.5} py={1.25}>
                <Box sx={{ color: `${s.color}.main`, pt: '2px' }}>{s.icon}</Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                    <Typography fontWeight={700}>{r.title}</Typography>
                    <Chip size="small" variant="outlined" color={s.color} label={t(r.severity)} sx={{ height: 20 }} />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={t(`cat_${r.category}`, { defaultValue: r.category })}
                      sx={{ height: 20 }}
                    />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" mt={0.25}>
                    {r.detail}
                  </Typography>
                  {r.action ? (
                    <Typography variant="body2" mt={0.5}>
                      <b>{t('whatToDo')}:</b> {r.action}
                    </Typography>
                  ) : null}
                  {r.sql ? (
                    <Box sx={{ position: 'relative', mt: 0.75 }}>
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 1.25,
                          pr: 5,
                          borderRadius: 1,
                          bgcolor: 'action.hover',
                          fontFamily: '"JetBrains Mono", monospace',
                          fontSize: 12,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}>
                        {r.sql}
                      </Box>
                      <Tooltip title={t('copySql')}>
                        <IconButton
                          size="small"
                          sx={{ position: 'absolute', top: 4, right: 4 }}
                          onClick={() => {
                            void navigator.clipboard?.writeText(r.sql ?? '');
                            toast.success(t('copied'));
                          }}>
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ) : null}
                </Box>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Card>
  );
};

type SortKey = 'total_bytes' | 'dead_pct' | 'bloat_bytes' | 'growth_bytes_per_day' | 'seq_scans';

const TablesCard: FC<{ rep: InsightsReport; database: string; onDatabase: (d: string) => void }> = ({
  rep,
  database,
  onDatabase,
}) => {
  const { t } = useTranslation('insights');
  const [sort, setSort] = useState<SortKey>('total_bytes');
  const items = useMemo(
    () => [...(rep.tables.items ?? [])].sort((a: InsightsTable, b: InsightsTable) => (b[sort] ?? 0) - (a[sort] ?? 0)),
    [rep.tables.items, sort],
  );
  const head = (key: SortKey, label: string) => (
    <TableCell align="right">
      <TableSortLabel active={sort === key} direction="desc" onClick={() => setSort(key)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
  return (
    <Card
      title={t('tables')}
      subtitle={t('tablesHelp')}
      action={
        <TextField
          select
          size="small"
          label={t('database')}
          value={rep.tables.database}
          onChange={(e) => onDatabase(e.target.value)}
          sx={{ minWidth: 180 }}>
          {(rep.tables.databases ?? [database]).map((d) => (
            <MenuItem key={d} value={d}>
              {d}
            </MenuItem>
          ))}
        </TextField>
      }>
      {rep.tables.error ? <Alert severity="warning">{rep.tables.error}</Alert> : null}
      <TableContainer sx={{ maxHeight: 520 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>{t('table')}</TableCell>
              {head('total_bytes', t('size'))}
              <TableCell align="right">{t('rows')}</TableCell>
              {head('dead_pct', t('deadRows'))}
              {head('bloat_bytes', t('wasted'))}
              {head('growth_bytes_per_day', t('growthPerDay'))}
              <TableCell align="right">{t('in30Days')}</TableCell>
              {head('seq_scans', t('scans'))}
              <TableCell>{t('lastVacuum')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((x) => (
              <TableRow key={x.name} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{x.name}</TableCell>
                <TableCell align="right">{bytes(x.total_bytes)}</TableCell>
                <TableCell align="right">{compact(x.live_rows)}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" gap={0.75} alignItems="center" justifyContent="flex-end">
                    {x.dead_pct >= 20 && x.dead_rows >= 10000 ? (
                      <WarningAmberIcon sx={{ fontSize: 16, color: 'warning.main' }} />
                    ) : null}
                    {pct(x.dead_pct)}
                  </Stack>
                </TableCell>
                <TableCell align="right">{x.bloat_bytes ? bytes(x.bloat_bytes) : '—'}</TableCell>
                <TableCell align="right">
                  {x.has_trend ? signed(bytes(x.growth_bytes_per_day), x.growth_bytes_per_day) : '—'}
                </TableCell>
                <TableCell align="right">{x.has_trend ? bytes(x.in_30_days) : '—'}</TableCell>
                <TableCell align="right">
                  <Tooltip title={t('scansHelp', { seq: compact(x.seq_scans), idx: compact(x.idx_scans) })}>
                    <span>
                      {compact(x.seq_scans)} / {compact(x.idx_scans)}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                  {x.last_vacuum ? new Date(x.last_vacuum).toLocaleDateString() : t('never')}
                </TableCell>
              </TableRow>
            ))}
            {!items.length ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ color: 'text.secondary', py: 3 }}>
                  {t('noTables')}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
      {rep.unused_indexes?.length ? (
        <Box mt={2}>
          <Typography variant="body2" fontWeight={700} mb={0.5}>
            {t('unusedIndexes')}
          </Typography>
          <Stack direction="row" gap={0.75} flexWrap="wrap">
            {rep.unused_indexes.map((i) => (
              <Chip
                key={i.name}
                size="small"
                variant="outlined"
                label={`${i.name} · ${bytes(i.bytes)}`}
                sx={{ fontFamily: 'monospace' }}
              />
            ))}
          </Stack>
        </Box>
      ) : null}
    </Card>
  );
};

const forecastText = (
  f: { has_forecast: boolean; in_30_days: number; confidence: string },
  fmt: (v: number) => string,
  t: TFunction<'insights'>,
) =>
  f.has_forecast
    ? t('in30DaysValue', { value: fmt(f.in_30_days), confidence: t(`conf_${f.confidence}`) })
    : t('collecting');

/** JumboSQL: Insights - what grows, what is busy, what will be needed, and what to fix. */
const Insights: FC = () => {
  const { t } = useTranslation('insights');
  const user = useSessionUser();
  const projectId = useAppSelector(selectCurrentProject);
  const [params, setParams] = useSearchParams();
  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId },
  );
  const allowed = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && can('insights.view', c.id, user)),
    [clusters.data, user],
  );
  const clusterId = Number(params.get('cluster')) || allowed[0]?.id || 0;
  const days = Number(params.get('days')) || 30;
  const database = params.get('database') ?? '';
  const set = (k: string, v: string | number, reset: string[] = []) => {
    const next = new URLSearchParams(params);
    next.set(k, String(v));
    reset.forEach((r) => next.delete(r));
    setParams(next, { replace: true });
  };
  const q = useGetInsightsQuery(
    { id: clusterId, days, database: database || undefined },
    { skip: !clusterId, pollingInterval: 300000 },
  );
  const rep = q.data;

  const nodes = (rep?.hosts ?? []).filter((h) => h.node);
  const hostSeries = (pick: (h: (typeof nodes)[number]) => ChartSeries['points'] | null) =>
    nodes.map((h, i) => ({ name: `${h.node} (${h.role})`, points: pick(h) ?? [], slot: i }));

  if (clusters.isSuccess && !allowed.length) {
    return (
      <Box p={2}>
        <Alert severity="info">{t('noClusters')}</Alert>
      </Box>
    );
  }

  const ov = rep?.overview;
  const st = rep?.storage.forecast;
  const tightestDisk = nodes
    .filter((h) => h.disk_size_bytes > 0)
    .sort((a, b) => (a.days_to_full < 0 ? 1 : b.days_to_full < 0 ? -1 : a.days_to_full - b.days_to_full))[0];
  const hottest = [...nodes].sort((a, b) => b.cpu_p95 - a.cpu_p95)[0];
  const since =
    rep?.collection.since && !rep.collection.since.startsWith('0001') ? new Date(rep.collection.since) : null;
  const historyDays = since ? (Date.now() - since.getTime()) / 86400000 : 0;
  const connPct =
    rep && rep.load.max_connections
      ? (100 * Math.max(rep.load.connections_peak, ov?.connections ?? 0)) / rep.load.max_connections
      : 0;

  return (
    <Stack gap={2} p={2}>
      <Box>
        <Typography variant="h6">{t('title')}</Typography>
        <Typography variant="body2" color="text.secondary" maxWidth={900}>
          {t('help')}
        </Typography>
      </Box>

      {/* filters: one row, scope everything below */}
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <TextField
          select
          size="small"
          label={t('cluster')}
          value={allowed.some((c) => c.id === clusterId) ? clusterId : ''}
          onChange={(e) => set('cluster', e.target.value, ['database'])}
          sx={{ minWidth: 200 }}>
          {allowed.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v) => v && set('days', v)}>
          {[1, 7, 30, 90].map((d) => (
            <ToggleButton key={d} value={d}>
              {t(`last_${d}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Tooltip title={t('refresh')}>
          <IconButton onClick={() => q.refetch()}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
        <Box flex={1} />
        {rep ? (
          <Typography variant="caption" color="text.secondary">
            {since
              ? t('collectingSince', {
                  date: since.toLocaleString(),
                  count: rep.collection.samples,
                  interval: rep.collection.interval,
                })
              : rep.collection.enabled
                ? t('noSamplesYet')
                : t('collectorOff')}
          </Typography>
        ) : null}
      </Stack>
      {q.isFetching ? <LinearProgress sx={{ height: 2, mt: -1.5 }} /> : null}
      {q.error ? (
        <Alert severity="error">
          {String((q.error as { data?: { description?: string } }).data?.description ?? t('loadFailed'))}
        </Alert>
      ) : null}
      {rep && historyDays < 7 ? <Alert severity="info">{t('youngHistory')}</Alert> : null}
      {rep?.overview_error ? (
        <Alert severity="warning">{t('overviewError', { error: rep.overview_error })}</Alert>
      ) : null}

      {rep ? (
        <Box
          sx={{
            opacity: q.isFetching ? 0.6 : 1,
            transition: 'opacity .2s',
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}>
          {/* headline numbers */}
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', xl: 'repeat(6, 1fr)' },
            }}>
            <Stat label={t('dbSize')} value={bytes(st?.current)} sub={st ? forecastText(st, (v) => bytes(v), t) : ''} />
            <Stat
              label={t('growthPerDay')}
              value={st?.has_forecast ? signed(bytes(st.per_day), st.per_day) : '—'}
              sub={st?.has_forecast ? t('perMonth', { value: bytes(st.per_day * 30) }) : t('collecting')}
            />
            <Stat
              label={t('tpsPeak')}
              value={compact(rep.load.tps_peak)}
              sub={
                rep.load.tps_forecast.has_forecast
                  ? forecastText(rep.load.tps_forecast, (v) => `${compact(v)}/s`, t)
                  : t('tpsHelp')
              }
            />
            <Stat
              label={t('connections')}
              value={`${ov?.connections ?? '—'} / ${rep.load.max_connections || '—'}`}
              tone={connPct >= 90 ? 'critical' : connPct >= 80 ? 'warning' : undefined}
              sub={t('connPeak', { peak: compact(rep.load.connections_peak), pct: pct(connPct) })}
            />
            <Stat
              label={t('cpuBusyHour')}
              value={hottest ? pct(hottest.cpu_p95) : '—'}
              tone={
                hottest && hottest.cpu_p95 >= 90 ? 'critical' : hottest && hottest.cpu_p95 >= 75 ? 'warning' : undefined
              }
              sub={
                hottest
                  ? `${hottest.node} · ${t('cpuIn30', { value: hottest.cpu_forecast.has_forecast ? cpuPct(hottest.cpu_forecast.in_30_days) : '—' })}`
                  : t('needsPrometheus')
              }
            />
            <Stat
              label={t('diskFull')}
              value={tightestDisk ? (daysText(tightestDisk.days_to_full) ?? t('notGrowing')) : '—'}
              tone={
                tightestDisk && tightestDisk.days_to_full >= 0 && tightestDisk.days_to_full <= 30
                  ? 'critical'
                  : tightestDisk && tightestDisk.days_to_80pct >= 0 && tightestDisk.days_to_80pct <= 90
                    ? 'warning'
                    : undefined
              }
              sub={
                tightestDisk
                  ? `${tightestDisk.node} · ${bytes(tightestDisk.disk_used?.at(-1)?.v)} / ${bytes(tightestDisk.disk_size_bytes)}`
                  : t('needsPrometheus')
              }
            />
          </Box>

          <Recommendations items={rep.recommendations ?? []} />

          {/* storage and load */}
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
            }}>
            <Card title={t('storageTitle')} subtitle={t('storageHelp')}>
              <TrendChart
                series={[
                  {
                    name: t('allDatabases'),
                    points: rep.storage.points ?? [],
                    slot: 0,
                    forecast: rep.storage.forecast.line,
                    area: true,
                  },
                ]}
                format={(v) => bytes(v, 0)}
                empty={t('collecting')}
              />
            </Card>
            <Card title={t('tpsTitle')} subtitle={t('tpsChartHelp')}>
              <TrendChart
                series={[
                  {
                    name: t('tps'),
                    points: rep.load.tps ?? [],
                    slot: 0,
                    forecast: rep.load.tps_forecast.line,
                    area: true,
                  },
                ]}
                format={(v) => compact(v)}
                empty={t('collecting')}
              />
            </Card>
            <Card title={t('connectionsTitle')} subtitle={t('connectionsHelp')}>
              <TrendChart
                series={[
                  {
                    name: t('connections'),
                    points: rep.load.connections ?? [],
                    slot: 0,
                    forecast: rep.load.connections_forecast.line,
                    area: true,
                  },
                ]}
                limits={
                  rep.load.max_connections
                    ? [{ value: rep.load.max_connections, label: `max_connections ${rep.load.max_connections}` }]
                    : []
                }
                format={(v) => compact(v)}
                empty={t('collecting')}
              />
            </Card>
            <Card title={t('rowsTitle')} subtitle={t('rowsHelp')}>
              {/* two scales (reads are usually far more than writes): two charts, never two axes */}
              <Typography variant="body2" fontWeight={700}>
                {t('rowsRead')}
              </Typography>
              <TrendChart
                series={[{ name: t('rowsRead'), points: rep.load.reads_per_sec ?? [], slot: 0, area: true }]}
                format={(v) => compact(v)}
                height={110}
                empty={t('collecting')}
              />
              <Typography variant="body2" fontWeight={700} mt={1}>
                {t('rowsWritten')}
              </Typography>
              <TrendChart
                series={[{ name: t('rowsWritten'), points: rep.load.writes_per_sec ?? [], slot: 1, area: true }]}
                format={(v) => compact(v)}
                height={110}
                empty={t('collecting')}
              />
            </Card>
          </Box>

          {/* nodes from Prometheus */}
          <Card
            title={t('nodesTitle')}
            subtitle={rep.hosts_source ? t('nodesSource', { url: rep.hosts_source }) : t('needsPrometheusLong')}>
            {rep.hosts_error ? (
              <Alert severity="warning" sx={{ mb: 1.5 }}>
                {t('prometheusError', { error: rep.hosts_error })}
              </Alert>
            ) : null}
            {nodes.length ? (
              <>
                <Box
                  sx={{
                    display: 'grid',
                    gap: 2,
                    gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(3, minmax(0, 1fr))' },
                    mb: 2,
                  }}>
                  <Box>
                    <Typography variant="body2" fontWeight={700}>
                      {t('cpu')}
                    </Typography>
                    <TrendChart
                      series={hostSeries((h) => h.cpu)}
                      format={(v) => `${v.toFixed(0)}%`}
                      yMax={100}
                      height={200}
                    />
                  </Box>
                  <Box>
                    <Typography variant="body2" fontWeight={700}>
                      {t('memory')}
                    </Typography>
                    <TrendChart
                      series={hostSeries((h) => h.mem)}
                      format={(v) => `${v.toFixed(0)}%`}
                      yMax={100}
                      height={200}
                    />
                  </Box>
                  <Box>
                    <Typography variant="body2" fontWeight={700}>
                      {t('diskUsed')}
                    </Typography>
                    <TrendChart
                      series={nodes.map((h, i) => ({
                        name: `${h.node} (${h.role})`,
                        points: h.disk_used ?? [],
                        slot: i,
                        forecast: h.disk_forecast.line,
                      }))}
                      format={(v) => bytes(v, 0)}
                      height={200}
                    />
                  </Box>
                </Box>
                <TableContainer>
                  <Table size="small">
                    <TableHead>
                      <TableRow>
                        <TableCell>{t('node')}</TableCell>
                        <TableCell align="right">{t('vcpu')}</TableCell>
                        <TableCell align="right">{t('cpuP95')}</TableCell>
                        <TableCell align="right">{t('cpuIn30Short')}</TableCell>
                        <TableCell align="right">{t('suggestedVcpu')}</TableCell>
                        <TableCell align="right">{t('ram')}</TableCell>
                        <TableCell align="right">{t('memP95')}</TableCell>
                        <TableCell align="right">{t('disk')}</TableCell>
                        <TableCell align="right">{t('growthPerDay')}</TableCell>
                        <TableCell align="right">{t('diskNeeded30')}</TableCell>
                        <TableCell align="right">{t('to80')}</TableCell>
                        <TableCell align="right">{t('toFull')}</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {nodes.map((h) => {
                        const want = suggestedCores(
                          h.cores,
                          h.cpu_p95,
                          h.cpu_forecast.has_forecast ? h.cpu_forecast.in_30_days : 0,
                        );
                        return (
                          <TableRow key={h.instance} hover>
                            <TableCell>
                              <b>{h.node}</b>{' '}
                              <Typography component="span" variant="caption" color="text.secondary">
                                {h.role} · {h.instance}
                              </Typography>
                            </TableCell>
                            <TableCell align="right">{h.cores || '—'}</TableCell>
                            <TableCell align="right">{pct(h.cpu_p95)}</TableCell>
                            <TableCell align="right">
                              {h.cpu_forecast.has_forecast ? cpuPct(h.cpu_forecast.in_30_days) : '—'}
                            </TableCell>
                            <TableCell
                              align="right"
                              sx={{
                                fontWeight: want > h.cores ? 700 : 400,
                                color: want > h.cores ? 'warning.main' : undefined,
                              }}>
                              {want > h.cores ? `${want} (+${want - h.cores})` : t('enough')}
                            </TableCell>
                            <TableCell align="right">{bytes(h.mem_total_bytes, 0)}</TableCell>
                            <TableCell align="right">{pct(h.mem_p95)}</TableCell>
                            <TableCell align="right">
                              {bytes(h.disk_used?.at(-1)?.v)} / {bytes(h.disk_size_bytes)}
                              {h.mount ? (
                                <Typography component="div" variant="caption" color="text.secondary">
                                  {h.mount}
                                </Typography>
                              ) : null}
                            </TableCell>
                            <TableCell align="right">
                              {h.disk_forecast.has_forecast
                                ? signed(bytes(h.disk_forecast.per_day), h.disk_forecast.per_day)
                                : '—'}
                            </TableCell>
                            <TableCell align="right">
                              {h.disk_forecast.has_forecast
                                ? bytes(Math.ceil(h.disk_forecast.in_30_days / 0.75 / 1024 ** 3) * 1024 ** 3, 0)
                                : '—'}
                            </TableCell>
                            <TableCell align="right">{daysText(h.days_to_80pct) ?? '—'}</TableCell>
                            <TableCell align="right">{daysText(h.days_to_full) ?? '—'}</TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
                <Typography variant="caption" color="text.secondary" component="div" mt={1}>
                  {t('nodesFootnote')}
                </Typography>
              </>
            ) : !rep.hosts_error ? (
              <Typography variant="body2" color="text.secondary">
                {rep.hosts_source ? t('noNodeMetrics') : t('needsPrometheusLong')}
              </Typography>
            ) : null}
          </Card>

          {/* databases */}
          <Card title={t('databases')} subtitle={t('databasesHelp')}>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('database')}</TableCell>
                    <TableCell align="right">{t('size')}</TableCell>
                    <TableCell align="right">{t('growthPerDay')}</TableCell>
                    <TableCell align="right">{t('in30Days')}</TableCell>
                    <TableCell>{t('confidence')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(rep.storage.databases ?? []).map((d) => (
                    <TableRow key={d.name} hover>
                      <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                      <TableCell align="right">{bytes(d.size_bytes)}</TableCell>
                      <TableCell align="right">
                        {d.forecast.has_forecast ? signed(bytes(d.forecast.per_day), d.forecast.per_day) : '—'}
                      </TableCell>
                      <TableCell align="right">
                        {d.forecast.has_forecast ? bytes(d.forecast.in_30_days) : '—'}
                      </TableCell>
                      <TableCell>
                        {d.forecast.has_forecast ? t(`conf_${d.forecast.confidence}`) : t('collecting')}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>

          <TablesCard rep={rep} database={database} onDatabase={(d) => set('database', d)} />

          {/* top queries */}
          <Card title={t('queriesTitle')} subtitle={ov?.pg_stat_statements ? t('queriesHelp') : t('noPgss')}>
            {rep.queries_error ? <Alert severity="warning">{rep.queries_error}</Alert> : null}
            {rep.queries?.length ? (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>{t('statement')}</TableCell>
                      <TableCell>{t('database')}</TableCell>
                      <TableCell align="right">{t('calls')}</TableCell>
                      <TableCell align="right">{t('totalTime')}</TableCell>
                      <TableCell align="right">{t('meanTime')}</TableCell>
                      <TableCell align="right">{t('shareOfTime')}</TableCell>
                      <TableCell align="right">{t('cacheHit')}</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {rep.queries.map((x, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ maxWidth: 520 }}>
                          <Tooltip title={<Box sx={{ fontFamily: 'monospace', fontSize: 12 }}>{x.query}</Box>}>
                            <Box
                              sx={{
                                fontFamily: 'monospace',
                                fontSize: 12,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}>
                              {x.query}
                            </Box>
                          </Tooltip>
                        </TableCell>
                        <TableCell>{x.database}</TableCell>
                        <TableCell align="right">{compact(x.calls)}</TableCell>
                        <TableCell align="right">{ms(x.total_ms)}</TableCell>
                        <TableCell align="right">{ms(x.mean_ms)}</TableCell>
                        <TableCell align="right">
                          <Stack direction="row" gap={1} alignItems="center" justifyContent="flex-end">
                            <Box
                              sx={{
                                width: 60,
                                height: 6,
                                borderRadius: 3,
                                bgcolor: 'action.hover',
                                overflow: 'hidden',
                              }}>
                              <Box
                                sx={{
                                  width: `${Math.min(100, x.share_pct)}%`,
                                  height: '100%',
                                  bgcolor: 'primary.main',
                                }}
                              />
                            </Box>
                            {pct(x.share_pct)}
                          </Stack>
                        </TableCell>
                        <TableCell align="right">{pct(x.hit_pct, 1)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : null}
          </Card>

          {ov ? (
            <Typography variant="caption" color="text.secondary">
              {t('serverLine', {
                version: ov.version,
                started: new Date(ov.started_at).toLocaleString(),
                sb: ov.shared_buffers,
                wm: ov.work_mem,
                hit: pct(ov.cache_hit_pct, 1),
                xid: compact(ov.xid_age_max),
              })}
            </Typography>
          ) : null}
        </Box>
      ) : null}
    </Stack>
  );
};

export default Insights;
