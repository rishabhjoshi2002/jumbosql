import { FC, useMemo } from 'react';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  LinearProgress,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import {
  Fleet,
  FleetCluster,
  useGetInsightsSummaryQuery,
  useLazyGetInsightsSummaryQuery,
} from '@shared/api/api/insights.ts';
import { Card, OUTLOOK_ICON, ScoreChip, Stat } from './parts.tsx';
import { bytes, daysText, pct, signed } from '../lib/format.ts';

/** the summary of every cluster the user may see (GET /insights/summary), worst first */
export const useFleet = (projectId: number) => {
  const q = useGetInsightsSummaryQuery({ projectId }, { skip: !projectId, pollingInterval: 300_000 });
  const [rebuild, rb] = useLazyGetInsightsSummaryQuery();
  return {
    ...q,
    rebuilding: rb.isFetching,
    /** rebuild every cluster's summary now, then reload */
    refresh: async () => {
      await rebuild({ projectId, refresh: true });
      await q.refetch();
    },
  };
};

const nodesText = (c: FleetCluster) => (c.servers ? `${c.healthy} / ${c.servers}` : '—');

/** The fleet's headline tiles. */
export const FleetTiles: FC<{ fleet: Fleet }> = ({ fleet }) => {
  const { t } = useTranslation('insights');
  const x = fleet.totals;
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', xl: 'repeat(6, 1fr)' },
      }}>
      <Stat
        label={t('fleetClusters')}
        value={String(x.clusters)}
        tone={x.healthy < x.clusters ? 'warning' : undefined}
        sub={t('fleetHealthy', { healthy: x.healthy, servers: x.servers })}
      />
      <Stat
        label={t('fleetScore')}
        value={x.clusters ? `${x.avg_score}` : '—'}
        tone={x.worst_score < 60 ? 'critical' : x.worst_score < 85 ? 'warning' : undefined}
        sub={t('fleetWorst', { score: x.worst_score })}
      />
      <Stat
        label={t('fleetIssues')}
        value={`${x.critical} / ${x.warning}`}
        tone={x.critical ? 'critical' : x.warning ? 'warning' : undefined}
        sub={t('fleetIssuesSub')}
      />
      <Stat
        label={t('fleetData')}
        value={bytes(x.size_bytes)}
        sub={t('fleetPerDay', { value: signed(bytes(x.size_per_day), x.size_per_day) })}
      />
      <Stat
        label={t('fleetInYear')}
        value={bytes(x.size_in_365)}
        sub={t('fleetIn30', { value: bytes(x.size_in_30) })}
      />
      <Stat
        label={t('fleetCapacity')}
        value={`${x.capacity_act} / ${x.capacity_watch}`}
        tone={x.capacity_act ? 'warning' : undefined}
        sub={t('fleetCapacitySub')}
      />
    </Box>
  );
};

/** One line per cluster: health, nodes, data, growth, issues. */
export const FleetTable: FC<{ fleet: Fleet; onOpen?: (id: number) => void; compact?: boolean }> = ({
  fleet,
  onOpen,
  compact,
}) => {
  const { t } = useTranslation('insights');
  const rows = fleet.clusters ?? [];
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>{t('cluster')}</TableCell>
            <TableCell>{t('health')}</TableCell>
            <TableCell align="right">{t('nodesUp')}</TableCell>
            <TableCell align="right">{t('dbSize')}</TableCell>
            {compact ? null : <TableCell align="right">{t('growthPerMonth')}</TableCell>}
            <TableCell align="right">{t('inOneYear')}</TableCell>
            {compact ? null : <TableCell align="right">{t('diskFull')}</TableCell>}
            {compact ? null : <TableCell align="right">{t('cpuP95')}</TableCell>}
            <TableCell>{t('issues')}</TableCell>
            {compact ? null : <TableCell>{t('mainConcern')}</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((c) => {
            const s = c.summary;
            const concern = s?.unreachable ?? s?.top?.[0]?.title ?? s?.outlook?.[0]?.text ?? '';
            return (
              <TableRow
                key={c.id}
                hover
                onClick={onOpen ? () => onOpen(c.id) : undefined}
                sx={{ cursor: onOpen ? 'pointer' : undefined, '& td': { whiteSpace: 'nowrap' } }}>
                <TableCell>
                  <Typography fontWeight={700} variant="body2">
                    {c.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {c.leader ? t('leaderIs', { node: c.leader }) : c.status}
                    {s?.version ? ` · PostgreSQL ${s.version.split(' ')[0]}` : ''}
                  </Typography>
                </TableCell>
                <TableCell>{s ? <ScoreChip score={s.score} grade={t(`grade_${s.grade}`)} /> : '—'}</TableCell>
                <TableCell
                  align="right"
                  sx={{ color: c.servers && c.healthy < c.servers ? 'error.main' : undefined, fontWeight: 600 }}>
                  {nodesText(c)}
                </TableCell>
                <TableCell align="right">{s ? bytes(s.size_bytes) : '—'}</TableCell>
                {compact ? null : (
                  <TableCell align="right">{s ? signed(bytes(s.size_per_day * 30), s.size_per_day) : '—'}</TableCell>
                )}
                <TableCell align="right">{s ? bytes(Math.max(s.size_in_365, s.size_bytes)) : '—'}</TableCell>
                {compact ? null : (
                  <TableCell
                    align="right"
                    sx={{
                      color:
                        s && s.disk_full_in_days >= 0 && s.disk_full_in_days <= 30
                          ? 'error.main'
                          : s && s.disk_full_in_days >= 0 && s.disk_full_in_days <= 90
                            ? 'warning.main'
                            : undefined,
                    }}>
                    {s ? (daysText(s.disk_full_in_days) ?? t('notGrowing')) : '—'}
                  </TableCell>
                )}
                {compact ? null : <TableCell align="right">{s?.cpu_p95_max ? pct(s.cpu_p95_max) : '—'}</TableCell>}
                <TableCell>
                  <Stack direction="row" gap={0.5}>
                    {s?.critical ? (
                      <Chip size="small" color="error" label={`${s.critical} ${t('critical')}`} sx={{ height: 20 }} />
                    ) : null}
                    {s?.warning ? (
                      <Chip
                        size="small"
                        color="warning"
                        variant="outlined"
                        label={`${s.warning} ${t('warning')}`}
                        sx={{ height: 20 }}
                      />
                    ) : null}
                    {s && !s.critical && !s.warning ? (
                      <Typography variant="caption" color="success.main">
                        {t('allGood')}
                      </Typography>
                    ) : null}
                  </Stack>
                </TableCell>
                {compact ? null : (
                  <TableCell sx={{ maxWidth: 340 }}>
                    <Typography variant="body2" noWrap title={concern}>
                      {concern || '—'}
                    </Typography>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
          {!rows.length ? (
            <TableRow>
              <TableCell colSpan={10} align="center" sx={{ color: 'text.secondary', py: 3 }}>
                {t('noClusters')}
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>
    </TableContainer>
  );
};

/** Data now vs a year from now, per cluster (bars on one shared scale). */
export const FleetGrowth: FC<{ fleet: Fleet }> = ({ fleet }) => {
  const { t } = useTranslation('insights');
  const rows = (fleet.clusters ?? []).filter((c) => c.summary);
  const top = Math.max(1, ...rows.map((c) => Math.max(c.summary!.size_in_365, c.summary!.size_bytes)));
  if (!rows.length) return <Typography color="text.secondary">{t('collecting')}</Typography>;
  return (
    <Stack gap={1.25}>
      <Stack direction="row" gap={2}>
        <Stack direction="row" alignItems="center" gap={0.75}>
          <Box sx={{ width: 12, height: 10, borderRadius: 0.5, bgcolor: 'primary.main' }} />
          <Typography variant="caption" color="text.secondary">
            {t('today')}
          </Typography>
        </Stack>
        <Stack direction="row" alignItems="center" gap={0.75}>
          <Box sx={{ width: 12, height: 10, borderRadius: 0.5, bgcolor: 'primary.main', opacity: 0.3 }} />
          <Typography variant="caption" color="text.secondary">
            {t('inOneYear')}
          </Typography>
        </Stack>
      </Stack>
      {rows.map((c) => {
        const s = c.summary!;
        const year = Math.max(s.size_in_365, s.size_bytes);
        return (
          <Box key={c.id}>
            <Stack direction="row" justifyContent="space-between" gap={1}>
              <Typography variant="body2" fontWeight={600} noWrap>
                {c.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {bytes(s.size_bytes)} → {bytes(year)}
              </Typography>
            </Stack>
            <Box sx={{ position: 'relative', height: 10, borderRadius: 1, bgcolor: 'action.hover', mt: 0.5 }}>
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  width: `${(100 * year) / top}%`,
                  bgcolor: 'primary.main',
                  opacity: 0.3,
                  borderRadius: 1,
                }}
              />
              <Box
                sx={{
                  position: 'absolute',
                  inset: 0,
                  width: `${(100 * s.size_bytes) / top}%`,
                  bgcolor: 'primary.main',
                  borderRadius: 1,
                }}
              />
            </Box>
          </Box>
        );
      })}
    </Stack>
  );
};

const ORDER: Record<string, number> = { critical: 0, warning: 1, info: 2, ok: 3 };

/** The most important things across all clusters (critical first). */
export const FleetRisks: FC<{ fleet: Fleet; max?: number; onOpen?: (id: number) => void }> = ({
  fleet,
  max = 8,
  onOpen,
}) => {
  const { t } = useTranslation('insights');
  const lines = useMemo(
    () =>
      (fleet.clusters ?? [])
        .flatMap((c) => [
          ...(c.summary?.unreachable
            ? [{ id: c.id, cluster: c.name, severity: 'critical', text: c.summary.unreachable }]
            : []),
          ...(c.summary?.outlook ?? [])
            .filter((o) => o.severity !== 'ok')
            .map((o) => ({ id: c.id, cluster: c.name, ...o })),
        ])
        .sort((a, b) => ORDER[a.severity] - ORDER[b.severity])
        .slice(0, max),
    [fleet, max],
  );
  if (!lines.length) return <Alert severity="success">{t('noRisks')}</Alert>;
  return (
    <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
      {lines.map((l, i) => (
        <Stack
          key={i}
          direction="row"
          gap={1.25}
          py={1}
          onClick={onOpen ? () => onOpen(l.id) : undefined}
          sx={{ cursor: onOpen ? 'pointer' : undefined }}>
          <Box sx={{ pt: '1px' }}>{OUTLOOK_ICON[l.severity]}</Box>
          <Box minWidth={0}>
            <Typography variant="caption" color="text.secondary" fontWeight={700}>
              {l.cluster}
            </Typography>
            <Typography variant="body2">{l.text}</Typography>
          </Box>
        </Stack>
      ))}
    </Stack>
  );
};

/** "All clusters" view of the Insights page. */
const FleetView: FC<{ projectId: number; onOpen: (id: number) => void }> = ({ projectId, onOpen }) => {
  const { t } = useTranslation('insights');
  const q = useFleet(projectId);
  const fleet = q.data;
  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" gap={1}>
        <Typography variant="body2" color="text.secondary" flex={1}>
          {t('fleetHelp')}
        </Typography>
        <Tooltip title={t('fleetRefresh')}>
          <span>
            <IconButton onClick={() => void q.refresh()} disabled={q.rebuilding}>
              <RefreshIcon />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {q.isFetching || q.rebuilding ? <LinearProgress sx={{ height: 2 }} /> : null}
      {q.error ? <Alert severity="error">{t('loadFailed')}</Alert> : null}
      {fleet ? (
        <>
          <FleetTiles fleet={fleet} />
          <Card title={t('fleetTable')} subtitle={t('fleetTableHelp')}>
            <FleetTable fleet={fleet} onOpen={onOpen} />
          </Card>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'repeat(2, minmax(0, 1fr))' },
            }}>
            <Card title={t('fleetRisks')} subtitle={t('fleetRisksHelp')}>
              <FleetRisks fleet={fleet} onOpen={onOpen} />
            </Card>
            <Card title={t('fleetGrowth')} subtitle={t('fleetGrowthHelp')}>
              <FleetGrowth fleet={fleet} />
            </Card>
          </Box>
          <Typography variant="caption" color="text.secondary">
            {t('fleetFootnote', { date: new Date(fleet.generated_at).toLocaleString() })}
          </Typography>
        </>
      ) : null}
    </Stack>
  );
};

export default FleetView;
