import { FC, useMemo } from 'react';
import {
  Alert,
  Box,
  Button,
  GlobalStyles,
  IconButton,
  LinearProgress,
  ListSubheader,
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import PrintOutlinedIcon from '@mui/icons-material/PrintOutlined';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { InsightsReport, useGetInsightsQuery } from '@shared/api/api/insights.ts';
import { can } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import TrendChart, { ChartSeries } from './TrendChart.tsx';
import FleetView from './Fleet.tsx';
import Capacity from './Capacity.tsx';
import { Card, forecastText, OUTLOOK_ICON, Recommendations, ScoreRing, Stat, TablesCard } from './parts.tsx';
import {
  bytes,
  compact,
  cpuPct,
  daysText,
  growthPct,
  horizonLabel,
  ms,
  pct,
  scoreColor,
  signed,
  suggestedCores,
} from '../lib/format.ts';

const HORIZONS = [30, 90, 180, 365];
const TABS = ['overview', 'capacity', 'recommendations', 'data', 'queries', 'nodes'] as const;
type TabKey = (typeof TABS)[number];

/* ------------------------------------------------------------ overview ------------------------------------------------------------ */

const Overview: FC<{ rep: InsightsReport; onTab: (t: TabKey) => void }> = ({ rep, onTab }) => {
  const { t } = useTranslation('insights');
  const ov = rep.overview;
  const st = rep.storage.forecast;
  const nodes = (rep.hosts ?? []).filter((h) => h.node);
  const hottest = [...nodes].sort((a, b) => b.cpu_p95 - a.cpu_p95)[0];
  const disks = (rep.capacity ?? []).filter((c) => c.kind === 'disk');
  const tightestDisk = [...disks].sort((a, b) =>
    a.limit_in_days < 0 ? 1 : b.limit_in_days < 0 ? -1 : a.limit_in_days - b.limit_in_days,
  )[0];
  const connPct =
    rep.load.max_connections > 0
      ? (100 * Math.max(rep.load.connections_peak, ov?.connections ?? 0)) / rep.load.max_connections
      : 0;
  const recs = rep.recommendations ?? [];
  const count = (s: string) => recs.filter((r) => r.severity === s).length;
  const act = (rep.capacity ?? []).filter((c) => c.status === 'act').length;
  const watch = (rep.capacity ?? []).filter((c) => c.status === 'watch').length;
  const h = rep.horizon || 30;

  return (
    <Stack gap={2}>
      {/* health score and the outlook: the two things a manager reads first */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1fr) minmax(0, 2fr)' },
        }}>
        <Card title={t('healthTitle')} subtitle={t('healthHelp')}>
          <Stack direction="row" gap={2.5} alignItems="center">
            <ScoreRing score={rep.score} label={t(`grade_${rep.grade}`)} />
            <Stack gap={0.75} minWidth={0}>
              <Typography variant="body2">
                <Box component="b" sx={{ color: 'error.main' }}>
                  {count('critical')}
                </Box>{' '}
                {t('critical')} ·{' '}
                <Box component="b" sx={{ color: 'warning.main' }}>
                  {count('warning')}
                </Box>{' '}
                {t('warning')} · <b>{count('info')}</b> {t('info')}
              </Typography>
              <Typography variant="body2">{t('capacityCounts', { act, watch })}</Typography>
              <Stack direction="row" gap={1} flexWrap="wrap">
                <Button size="small" variant="outlined" onClick={() => onTab('recommendations')}>
                  {t('seeFindings')}
                </Button>
                <Button size="small" variant="outlined" onClick={() => onTab('capacity')}>
                  {t('seePlan')}
                </Button>
              </Stack>
            </Stack>
          </Stack>
        </Card>
        <Card title={t('outlookTitle', { horizon: horizonLabel(h) })} subtitle={t('outlookHelp')}>
          <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
            {(rep.outlook ?? []).map((o, i) => (
              <Stack key={i} direction="row" gap={1.25} py={0.75}>
                <Box sx={{ pt: '1px' }}>{OUTLOOK_ICON[o.severity]}</Box>
                <Typography variant="body2">{o.text}</Typography>
              </Stack>
            ))}
            {!rep.outlook?.length ? (
              <Typography variant="body2" color="text.secondary">
                {t('collecting')}
              </Typography>
            ) : null}
          </Stack>
        </Card>
      </Box>

      {/* headline numbers */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', xl: 'repeat(6, 1fr)' },
        }}>
        <Stat label={t('dbSize')} value={bytes(st.current)} sub={forecastText(st, (v) => bytes(v), t)} />
        <Stat
          label={t('growthPerDay')}
          value={st.has_forecast ? signed(bytes(st.per_day), st.per_day) : '—'}
          sub={
            st.has_forecast
              ? t('perMonthPct', { value: bytes(st.per_day * 30), pct: growthPct(st.growth_pct_month) })
              : t('collecting')
          }
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
          value={tightestDisk ? (daysText(tightestDisk.limit_in_days) ?? t('notGrowing')) : '—'}
          tone={tightestDisk?.status === 'act' ? 'critical' : tightestDisk?.status === 'watch' ? 'warning' : undefined}
          sub={
            tightestDisk
              ? `${tightestDisk.node} · ${bytes(tightestDisk.now)} / ${bytes(tightestDisk.limit)}`
              : t('needsPrometheus')
          }
        />
      </Box>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
        }}>
        <Card title={t('storageTitle')} subtitle={t('storageHelp')}>
          <TrendChart
            series={[{ name: t('allDatabases'), points: rep.storage.points ?? [], slot: 0, band: st.band, area: true }]}
            format={(v) => bytes(v, 0)}
            empty={t('collecting')}
          />
        </Card>
        <Card title={t('tpsTitle')} subtitle={t('tpsChartHelp')}>
          <TrendChart
            series={[
              { name: t('tps'), points: rep.load.tps ?? [], slot: 0, band: rep.load.tps_forecast.band, area: true },
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
                band: rep.load.connections_forecast.band,
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
    </Stack>
  );
};

/* ------------------------------------------------------------ data: databases and tables ------------------------------------------------------------ */

const Data: FC<{ rep: InsightsReport; database: string; onDatabase: (d: string) => void }> = ({
  rep,
  database,
  onDatabase,
}) => {
  const { t } = useTranslation('insights');
  const dbs = rep.storage.databases ?? [];
  return (
    <Stack gap={2}>
      <Card title={t('databases')} subtitle={t('databasesHelp')}>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('database')}</TableCell>
                <TableCell align="right">{t('size')}</TableCell>
                <TableCell align="right">{t('growthPerDay')}</TableCell>
                <TableCell align="right">{t('growthPerMonth')}</TableCell>
                {HORIZONS.map((d) => (
                  <TableCell key={d} align="right">
                    {t('inHorizon', { horizon: horizonLabel(d) })}
                  </TableCell>
                ))}
                <TableCell>{t('confidence')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {dbs.map((d) => (
                <TableRow key={d.name} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{d.name}</TableCell>
                  <TableCell align="right">{bytes(d.size_bytes)}</TableCell>
                  <TableCell align="right">
                    {d.forecast.has_forecast ? signed(bytes(d.forecast.per_day), d.forecast.per_day) : '—'}
                  </TableCell>
                  <TableCell align="right">
                    {d.forecast.has_forecast ? growthPct(d.forecast.growth_pct_month) : '—'}
                  </TableCell>
                  {HORIZONS.map((h) => {
                    const p = d.forecast.projections?.find((x) => x.days === h);
                    return (
                      <TableCell key={h} align="right" sx={{ opacity: p && !p.reliable ? 0.6 : 1 }}>
                        {d.forecast.has_forecast && p ? bytes(p.v) : '—'}
                      </TableCell>
                    );
                  })}
                  <TableCell>
                    {d.forecast.has_forecast ? t(`conf_${d.forecast.confidence}`) : t('collecting')}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" color="text.secondary" component="div" mt={1}>
          {t('fadedRough')}
        </Typography>
      </Card>
      <TablesCard rep={rep} database={database} onDatabase={onDatabase} />
    </Stack>
  );
};

/* ------------------------------------------------------------ queries ------------------------------------------------------------ */

const Queries: FC<{ rep: InsightsReport }> = ({ rep }) => {
  const { t } = useTranslation('insights');
  return (
    <Card title={t('queriesTitle')} subtitle={rep.overview?.pg_stat_statements ? t('queriesHelp') : t('noPgss')}>
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
                      <Box sx={{ width: 60, height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                        <Box
                          sx={{ width: `${Math.min(100, x.share_pct)}%`, height: '100%', bgcolor: 'primary.main' }}
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
  );
};

/* ------------------------------------------------------------ nodes (Prometheus) ------------------------------------------------------------ */

const Nodes: FC<{ rep: InsightsReport }> = ({ rep }) => {
  const { t } = useTranslation('insights');
  const nodes = (rep.hosts ?? []).filter((h) => h.node);
  const hostSeries = (pick: (h: (typeof nodes)[number]) => ChartSeries['points'] | null) =>
    nodes.map((h, i) => ({ name: `${h.node} (${h.role})`, points: pick(h) ?? [], slot: i }));
  return (
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
  );
};

/* ------------------------------------------------------------ page ------------------------------------------------------------ */

/** pg_genin: Insights - health, what grows, what will be needed and when, and what to fix; for one cluster or all. */
const Insights: FC = () => {
  const { t } = useTranslation('insights');
  const user = useSessionUser();
  const projectId = Number(useAppSelector(selectCurrentProject));
  const [params, setParams] = useSearchParams();
  const clusters = useGetClustersQuery({ projectId, offset: 0, limit: 999_999_999 }, { skip: !projectId });
  const allowed = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && can('insights.view', c.id, user)),
    [clusters.data, user],
  );
  // several clusters: start on the summary of all of them
  const raw = params.get('cluster');
  const all = raw === 'all' || (!raw && allowed.length > 1);
  const clusterId = all ? 0 : Number(raw) || allowed[0]?.id || 0;
  const days = Number(params.get('days')) || 30;
  const horizon = HORIZONS.includes(Number(params.get('horizon'))) ? Number(params.get('horizon')) : 30;
  const database = params.get('database') ?? '';
  const tab: TabKey = TABS.includes(params.get('tab') as TabKey) ? (params.get('tab') as TabKey) : 'overview';
  const set = (k: string, v: string | number, reset: string[] = []) => {
    const next = new URLSearchParams(params);
    next.set(k, String(v));
    reset.forEach((r) => next.delete(r));
    setParams(next, { replace: true });
  };
  const q = useGetInsightsQuery(
    { id: clusterId, days, horizon, database: database || undefined },
    { skip: !clusterId, pollingInterval: 300000 },
  );
  const rep = q.data;

  if (clusters.isSuccess && !allowed.length) {
    return (
      <Box p={2}>
        <Alert severity="info">{t('noClusters')}</Alert>
      </Box>
    );
  }

  const since =
    rep?.collection.since && !rep.collection.since.startsWith('0001') ? new Date(rep.collection.since) : null;
  const historyDays = since ? (Date.now() - since.getTime()) / 86400000 : 0;
  const recCount = (rep?.recommendations ?? []).filter((r) => r.severity !== 'info').length;
  const capCount = (rep?.capacity ?? []).filter((c) => c.status !== 'ok').length;

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
      <Stack direction="row" alignItems="flex-start" gap={2}>
        <Box flex={1}>
          <Typography variant="h6">{t('title')}</Typography>
          <Typography variant="body2" color="text.secondary" maxWidth={900}>
            {t('help')}
          </Typography>
        </Box>
        {rep && !all ? (
          <Stack direction="row" alignItems="center" gap={1.5} data-print-hide>
            <Box textAlign="right">
              <Typography variant="caption" color="text.secondary" component="div">
                {t('healthTitle')}
              </Typography>
              <Typography fontWeight={700} sx={{ color: `${scoreColor(rep.score)}.main` }}>
                {rep.score} / 100 · {t(`grade_${rep.grade}`)}
              </Typography>
            </Box>
          </Stack>
        ) : null}
      </Stack>

      {/* filters: one row, scope everything below */}
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap" data-print-hide>
        <TextField
          select
          size="small"
          label={t('cluster')}
          value={all ? 'all' : allowed.some((c) => c.id === clusterId) ? clusterId : ''}
          onChange={(e) => set('cluster', e.target.value, ['database'])}
          sx={{ minWidth: 220 }}>
          {allowed.length > 1 ? <MenuItem value="all">{t('allClusters', { count: allowed.length })}</MenuItem> : null}
          {allowed.length > 1 ? <ListSubheader>{t('oneCluster')}</ListSubheader> : null}
          {allowed.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        {!all ? (
          <>
            <ToggleButtonGroup size="small" exclusive value={days} onChange={(_, v) => v && set('days', v)}>
              {[1, 7, 30, 90].map((d) => (
                <ToggleButton key={d} value={d}>
                  {t(`last_${d}`)}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <TextField
              select
              size="small"
              label={t('lookAhead')}
              value={horizon}
              onChange={(e) => set('horizon', e.target.value)}
              sx={{ minWidth: 150 }}>
              {HORIZONS.map((h) => (
                <MenuItem key={h} value={h}>
                  {horizonLabel(h)}
                </MenuItem>
              ))}
            </TextField>
            <Tooltip title={t('refresh')}>
              <IconButton onClick={() => q.refetch()}>
                <RefreshIcon />
              </IconButton>
            </Tooltip>
          </>
        ) : null}
        <Tooltip title={t('print')}>
          <IconButton onClick={() => window.print()}>
            <PrintOutlinedIcon />
          </IconButton>
        </Tooltip>
        <Box flex={1} />
        {rep && !all ? (
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

      {all ? (
        <FleetView projectId={projectId} onOpen={(id) => set('cluster', id, ['database', 'tab'])} />
      ) : (
        <>
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
            <>
              <Tabs
                value={tab}
                onChange={(_, v) => set('tab', v)}
                variant="scrollable"
                data-print-hide
                sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
                <Tab value="overview" label={t('tab_overview')} />
                <Tab value="capacity" label={capCount ? `${t('tab_capacity')} (${capCount})` : t('tab_capacity')} />
                <Tab
                  value="recommendations"
                  label={recCount ? `${t('tab_recommendations')} (${recCount})` : t('tab_recommendations')}
                />
                <Tab value="data" label={t('tab_data')} />
                <Tab value="queries" label={t('tab_queries')} />
                <Tab value="nodes" label={t('tab_nodes')} />
              </Tabs>
              <Box sx={{ opacity: q.isFetching ? 0.6 : 1, transition: 'opacity .2s' }}>
                {tab === 'overview' ? <Overview rep={rep} onTab={(v) => set('tab', v)} /> : null}
                {tab === 'capacity' ? <Capacity rep={rep} /> : null}
                {tab === 'recommendations' ? <Recommendations items={rep.recommendations ?? []} /> : null}
                {tab === 'data' ? <Data rep={rep} database={database} onDatabase={(d) => set('database', d)} /> : null}
                {tab === 'queries' ? <Queries rep={rep} /> : null}
                {tab === 'nodes' ? <Nodes rep={rep} /> : null}
              </Box>
              {rep.overview ? (
                <Typography variant="caption" color="text.secondary">
                  {t('serverLine', {
                    version: rep.overview.version,
                    started: new Date(rep.overview.started_at).toLocaleString(),
                    sb: rep.overview.shared_buffers,
                    wm: rep.overview.work_mem,
                    hit: pct(rep.overview.cache_hit_pct, 1),
                    xid: compact(rep.overview.xid_age_max),
                  })}
                </Typography>
              ) : null}
            </>
          ) : null}
        </>
      )}
    </Stack>
  );
};

export default Insights;
