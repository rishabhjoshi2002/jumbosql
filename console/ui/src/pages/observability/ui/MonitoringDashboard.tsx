import { FC, ReactNode, useMemo } from 'react';
import { Alert, Box, Chip, LinearProgress, Stack, Tooltip, Typography } from '@mui/material';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import WarningAmber from '@mui/icons-material/WarningAmber';
import HelpOutline from '@mui/icons-material/HelpOutline';
import { useTranslation } from 'react-i18next';
import { MonPanel, Monitoring, useGetMonitoringQuery } from '@shared/api/api/monitoring.ts';
import TrendChart from '@pages/insights/ui/TrendChart.tsx';
import { bytes, compact } from '@pages/insights/lib/format.ts';

type Tone = 'good' | 'warning' | 'critical' | 'unknown';
const TONE: Record<Tone, { color: string; icon: ReactNode }> = {
  good: { color: 'success.main', icon: <CheckCircleOutline fontSize="small" /> },
  warning: { color: 'warning.main', icon: <WarningAmber fontSize="small" /> },
  critical: { color: 'error.main', icon: <ErrorOutline fontSize="small" /> },
  unknown: { color: 'text.disabled', icon: <HelpOutline fontSize="small" /> },
};

const SERVICE_ORDER = [
  'postgres',
  'patroni',
  'etcd',
  'haproxy',
  'pgbouncer',
  'pgbackrest',
  'node',
  'prometheus',
  'alertmanager',
  'grafana',
];
const SERVICE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  patroni: 'Patroni',
  etcd: 'etcd',
  haproxy: 'HAProxy',
  pgbouncer: 'PgBouncer',
  pgbackrest: 'pgBackRest',
  node: 'Nodes (node_exporter)',
  prometheus: 'Prometheus',
  alertmanager: 'Alertmanager',
  grafana: 'Grafana',
};

const Health: FC<{ label: string; value: string; sub?: string; tone: Tone }> = ({ label, value, sub, tone }) => (
  <Box
    sx={{
      border: 1,
      borderColor: tone === 'good' || tone === 'unknown' ? 'divider' : TONE[tone].color,
      borderRadius: 2,
      p: 1.75,
      bgcolor: 'background.paper',
      minWidth: 0,
    }}>
    <Stack direction="row" alignItems="center" gap={0.75} sx={{ color: TONE[tone].color }}>
      {TONE[tone].icon}
      <Typography variant="body2" color="text.secondary" noWrap>
        {label}
      </Typography>
    </Stack>
    <Typography sx={{ fontSize: 24, fontWeight: 650, lineHeight: 1.3, mt: 0.5 }} noWrap>
      {value}
    </Typography>
    <Typography variant="caption" color="text.secondary" component="div" noWrap sx={{ minHeight: 18 }}>
      {sub}
    </Typography>
  </Box>
);

const ago = (s?: number) => {
  if (s === undefined) return '—';
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400 * 2) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
};

const ChartCard: FC<{
  title: string;
  panel?: MonPanel;
  format: (v: number) => string;
  yMax?: number;
  limit?: { value: number; label: string };
  empty: string;
}> = ({ title, panel, format, yMax, limit, empty }) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 1.75, bgcolor: 'background.paper', minWidth: 0 }}>
    <Typography fontWeight={700} fontSize="0.95rem" mb={0.5}>
      {title}
    </Typography>
    <TrendChart
      series={(panel?.series ?? []).map((s, i) => ({ name: s.name, points: s.points ?? [], slot: i }))}
      format={format}
      yMax={yMax}
      limits={limit ? [limit] : []}
      height={180}
      empty={empty}
      legend
    />
  </Box>
);

const Grid: FC<{ children: ReactNode }> = ({ children }) => (
  <Box
    sx={{
      display: 'grid',
      gap: 2,
      gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' },
    }}>
    {children}
  </Box>
);

const Section: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <Box>
    <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: '0.08em' }}>
      {title}
    </Typography>
    {children}
  </Box>
);

const hasData = (m: Monitoring | undefined, ids: string[]) => ids.some((id) => (m?.panels[id]?.series.length ?? 0) > 0);

/** JumboSQL: a cluster's health and main graphs, straight from its Prometheus. */
const MonitoringDashboard: FC<{ clusterId: number; clusterStatus?: string; minutes: number }> = ({
  clusterId,
  clusterStatus,
  minutes,
}) => {
  const { t } = useTranslation('shared');
  const q = useGetMonitoringQuery({ id: clusterId, minutes }, { pollingInterval: 30000, skipPollingIfUnfocused: true });
  const m = q.data;
  const st = m?.stats ?? {};
  const empty = t('monNotCollected');

  const services = useMemo(() => {
    const by: Record<string, Monitoring['targets']> = {};
    (m?.targets ?? []).forEach((x) => (by[x.service] ??= []).push(x));
    return Object.entries(by).sort(
      ([a], [b]) => (SERVICE_ORDER.indexOf(a) + 1 || 99) - (SERVICE_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b),
    );
  }, [m?.targets]);

  if (q.isLoading) return <LinearProgress />;
  if (q.error) return <Alert severity="error">{t('monLoadFailed')}</Alert>;
  if (!m) return null;
  if (m.error) {
    return <Alert severity="warning">{t('monNoPrometheus', { url: m.prometheus || '—', error: m.error })}</Alert>;
  }

  const targetsUp = m.targets.filter((x) => x.up).length;
  const down = m.targets.filter((x) => !x.up);
  const etcd = m.targets.filter((x) => x.service === 'etcd');
  const etcdUp = etcd.filter((x) => x.up).length;
  const firing = m.alerts.filter((a) => a.state === 'firing');
  const critical = firing.filter((a) => a.severity === 'critical').length;
  const statusTone: Tone = !clusterStatus
    ? 'unknown'
    : /healthy|ready|running/i.test(clusterStatus)
      ? 'good'
      : /fail|error|unavailable/i.test(clusterStatus)
        ? 'critical'
        : 'warning';
  const pgTone: Tone =
    st.pg_instances === undefined
      ? 'unknown'
      : st.pg_up === st.pg_instances
        ? 'good'
        : st.pg_up
          ? 'warning'
          : 'critical';
  const etcdTone: Tone = !etcd.length
    ? st.etcd_has_leader === undefined
      ? 'unknown'
      : st.etcd_has_leader
        ? 'good'
        : 'critical'
    : st.etcd_has_leader === 0 || etcdUp * 2 <= etcd.length
      ? 'critical'
      : etcdUp < etcd.length
        ? 'warning'
        : 'good';
  const lag = st.max_repl_lag_s;
  const backup = st.backup_age;

  return (
    <Stack gap={2.5} sx={{ opacity: q.isFetching && !q.isLoading ? 0.7 : 1, transition: 'opacity .2s' }}>
      {/* health at a glance */}
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: {
            xs: 'repeat(2, minmax(0, 1fr))',
            md: 'repeat(3, minmax(0, 1fr))',
            xl: 'repeat(6, minmax(0, 1fr))',
          },
        }}>
        <Health
          label={t('monCluster')}
          value={clusterStatus || '—'}
          tone={statusTone}
          sub={
            st.patroni_members !== undefined
              ? t('monPatroniSub', {
                  running: st.patroni_running ?? 0,
                  members: st.patroni_members,
                  leaders: st.patroni_leaders ?? 0,
                })
              : undefined
          }
        />
        <Health
          label="PostgreSQL"
          value={st.pg_instances !== undefined ? `${st.pg_up ?? 0} / ${st.pg_instances} ${t('monUp')}` : '—'}
          tone={pgTone}
          sub={
            lag !== undefined
              ? t('monLagSub', { lag: lag < 1 ? `${(lag * 1000).toFixed(0)} ms` : `${lag.toFixed(1)} s` })
              : undefined
          }
        />
        <Health
          label="etcd"
          value={
            etcd.length
              ? `${etcdUp} / ${etcd.length} ${t('monUp')}`
              : st.etcd_members !== undefined
                ? `${st.etcd_members}`
                : '—'
          }
          tone={etcdTone}
          sub={
            st.etcd_has_leader !== undefined ? (st.etcd_has_leader ? t('monHasLeader') : t('monNoLeader')) : undefined
          }
        />
        <Health
          label={t('monServices')}
          value={`${targetsUp} / ${m.targets.length} ${t('monUp')}`}
          tone={!m.targets.length ? 'unknown' : down.length ? 'critical' : 'good'}
          sub={down.length ? t('monDown', { list: down.map((d) => d.node ?? d.instance).join(', ') }) : t('monAllUp')}
        />
        <Health
          label={t('monAlerts')}
          value={String(firing.length)}
          tone={critical ? 'critical' : firing.length ? 'warning' : 'good'}
          sub={firing.length ? t('monAlertsSub', { critical, other: firing.length - critical }) : t('monNoAlerts')}
        />
        <Health
          label={t('monBackup')}
          value={backup !== undefined ? t('monAgo', { age: ago(backup) }) : '—'}
          tone={
            backup === undefined ? 'unknown' : backup > 8 * 86400 ? 'critical' : backup > 2 * 86400 ? 'warning' : 'good'
          }
          sub={
            st.backup_incr_age !== undefined
              ? t('monIncr', { age: ago(st.backup_incr_age) })
              : backup === undefined
                ? t('monNoBackupMetric')
                : t('monFull')
          }
        />
      </Box>

      {/* alerts */}
      {firing.length ? (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}>
          {firing.map((a, i) => (
            <Stack
              key={i}
              direction="row"
              gap={1.25}
              alignItems="center"
              sx={{ px: 2, py: 1, borderTop: i ? 1 : 0, borderColor: 'divider' }}>
              <Box sx={{ color: a.severity === 'critical' ? 'error.main' : 'warning.main', display: 'flex' }}>
                {a.severity === 'critical' ? <ErrorOutline fontSize="small" /> : <WarningAmber fontSize="small" />}
              </Box>
              <Typography fontWeight={700} fontSize="0.9rem">
                {a.name}
              </Typography>
              {a.severity ? <Chip size="small" variant="outlined" label={a.severity} sx={{ height: 20 }} /> : null}
              <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {a.summary || a.instance}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {t('monSince', { date: new Date(a.since).toLocaleString() })}
              </Typography>
            </Stack>
          ))}
        </Box>
      ) : null}

      {/* services */}
      <Section title={t('monServicesTitle')}>
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            gridTemplateColumns: {
              xs: 'minmax(0, 1fr)',
              md: 'repeat(2, minmax(0, 1fr))',
              xl: 'repeat(4, minmax(0, 1fr))',
            },
          }}>
          {services.map(([svc, list]) => {
            const ok = list.filter((x) => x.up).length;
            const tone: Tone = ok === list.length ? 'good' : ok ? 'warning' : 'critical';
            return (
              <Box
                key={svc}
                sx={{
                  border: 1,
                  borderColor: tone === 'good' ? 'divider' : TONE[tone].color,
                  borderRadius: 2,
                  p: 1.5,
                  bgcolor: 'background.paper',
                }}>
                <Stack direction="row" alignItems="center" gap={0.75} mb={1}>
                  <Box sx={{ color: TONE[tone].color, display: 'flex' }}>{TONE[tone].icon}</Box>
                  <Typography fontWeight={700}>{SERVICE_LABEL[svc] ?? svc}</Typography>
                  <Typography variant="caption" color="text.secondary" ml="auto">
                    {ok} / {list.length} {t('monUp')}
                  </Typography>
                </Stack>
                <Stack direction="row" gap={0.75} flexWrap="wrap">
                  {list.map((x) => (
                    <Tooltip key={x.instance} title={`${x.job} · ${x.instance}${x.role ? ` · ${x.role}` : ''}`}>
                      <Chip
                        size="small"
                        variant="outlined"
                        color={x.up ? 'success' : 'error'}
                        icon={x.up ? <CheckCircleOutline /> : <ErrorOutline />}
                        label={x.node ?? x.instance}
                      />
                    </Tooltip>
                  ))}
                </Stack>
              </Box>
            );
          })}
        </Box>
      </Section>

      <Section title="PostgreSQL">
        <Grid>
          <ChartCard
            title={t('monConnections')}
            panel={m.panels.pg_connections}
            format={(v) => compact(v)}
            limit={
              st.max_connections
                ? { value: st.max_connections, label: `max_connections ${st.max_connections}` }
                : undefined
            }
            empty={empty}
          />
          <ChartCard title={t('monTps')} panel={m.panels.pg_tps} format={(v) => compact(v)} empty={empty} />
          <ChartCard
            title={t('monReplLag')}
            panel={hasData(m, ['pg_replication_lag']) ? m.panels.pg_replication_lag : m.panels.pg_replication_lag_bytes}
            format={
              hasData(m, ['pg_replication_lag'])
                ? (v) => (v < 1 ? `${(v * 1000).toFixed(0)} ms` : `${v.toFixed(1)} s`)
                : (v) => bytes(v, 0)
            }
            empty={empty}
          />
          <ChartCard
            title={t('monCacheHit')}
            panel={m.panels.pg_cache_hit}
            format={(v) => `${v.toFixed(1)}%`}
            yMax={100}
            empty={empty}
          />
          <ChartCard title={t('monDbSize')} panel={m.panels.pg_db_size} format={(v) => bytes(v, 0)} empty={empty} />
          <ChartCard title={t('monDeadlocks')} panel={m.panels.pg_deadlocks} format={(v) => compact(v)} empty={empty} />
        </Grid>
      </Section>

      <Section title={t('monNodes')}>
        <Grid>
          <ChartCard
            title={t('monCpu')}
            panel={m.panels.node_cpu}
            format={(v) => `${v.toFixed(0)}%`}
            yMax={100}
            empty={empty}
          />
          <ChartCard
            title={t('monMem')}
            panel={m.panels.node_mem}
            format={(v) => `${v.toFixed(0)}%`}
            yMax={100}
            empty={empty}
          />
          <ChartCard
            title={t('monDisk')}
            panel={m.panels.node_disk}
            format={(v) => `${v.toFixed(0)}%`}
            yMax={100}
            empty={empty}
          />
          <ChartCard title={t('monLoad')} panel={m.panels.node_load} format={(v) => v.toFixed(1)} empty={empty} />
          <ChartCard
            title={t('monNetIn')}
            panel={m.panels.node_net_in}
            format={(v) => `${bytes(v, 0)}/s`}
            empty={empty}
          />
          <ChartCard
            title={t('monNetOut')}
            panel={m.panels.node_net_out}
            format={(v) => `${bytes(v, 0)}/s`}
            empty={empty}
          />
          <ChartCard
            title={t('monDiskBusy')}
            panel={m.panels.node_disk_busy}
            format={(v) => `${v.toFixed(0)}%`}
            yMax={100}
            empty={empty}
          />
        </Grid>
      </Section>

      {hasData(m, ['etcd_db_size', 'etcd_fsync_p99', 'etcd_leader_changes']) || etcd.length ? (
        <Section title="etcd">
          <Grid>
            <ChartCard
              title={t('monEtcdSize')}
              panel={m.panels.etcd_db_size}
              format={(v) => bytes(v, 0)}
              empty={empty}
            />
            <ChartCard
              title={t('monEtcdFsync')}
              panel={m.panels.etcd_fsync_p99}
              format={(v) => `${(v * 1000).toFixed(1)} ms`}
              empty={empty}
            />
            <ChartCard
              title={t('monEtcdLeaderChanges')}
              panel={m.panels.etcd_leader_changes}
              format={(v) => compact(v)}
              empty={empty}
            />
          </Grid>
        </Section>
      ) : null}

      {hasData(m, ['haproxy_backends', 'pgbouncer_clients']) ? (
        <Section title={t('monProxies')}>
          <Grid>
            <ChartCard
              title={t('monHaproxy')}
              panel={m.panels.haproxy_backends}
              format={(v) => compact(v)}
              empty={empty}
            />
            <ChartCard
              title={t('monPgbouncer')}
              panel={m.panels.pgbouncer_clients}
              format={(v) => compact(v)}
              empty={empty}
            />
          </Grid>
        </Section>
      ) : null}

      <Typography variant="caption" color="text.secondary">
        {t('monFooter', { url: m.prometheus, date: new Date(m.generated_at).toLocaleTimeString() })}
      </Typography>
    </Stack>
  );
};

export default MonitoringDashboard;
