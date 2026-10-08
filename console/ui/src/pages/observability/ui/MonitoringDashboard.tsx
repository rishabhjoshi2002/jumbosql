import { FC, ReactNode, useMemo, useState } from 'react';
import { Alert, Box, Chip, LinearProgress, Stack, Tab, Tabs, Tooltip, Typography } from '@mui/material';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import WarningAmber from '@mui/icons-material/WarningAmber';
import HelpOutline from '@mui/icons-material/HelpOutline';
import { useTranslation } from 'react-i18next';
import { Monitoring, MonPanel, MonVM, useGetMonitoringQuery } from '@shared/api/api/monitoring.ts';
import TrendChart from '@pages/insights/ui/TrendChart.tsx';
import { bytes, compact } from '@pages/insights/lib/format.ts';

type Tone = 'good' | 'warning' | 'critical' | 'unknown';
const TONE: Record<Tone, { color: string; icon: ReactNode }> = {
  good: { color: 'success.main', icon: <CheckCircleOutline fontSize="small" /> },
  warning: { color: 'warning.main', icon: <WarningAmber fontSize="small" /> },
  critical: { color: 'error.main', icon: <ErrorOutline fontSize="small" /> },
  unknown: { color: 'text.disabled', icon: <HelpOutline fontSize="small" /> },
};

const KIND_ORDER = ['database', 'etcd', 'proxy', 'backup', 'monitoring', 'other'];
const SERVICE_LABEL: Record<string, string> = {
  postgres: 'PostgreSQL',
  patroni: 'Patroni',
  etcd: 'etcd',
  haproxy: 'HAProxy',
  pgbouncer: 'PgBouncer',
  pgbackrest: 'pgBackRest',
  node: 'node',
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

/** pg_genin: a cluster's health and main graphs, straight from its Prometheus. */
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

  const [tab, setTab] = useState<'cluster' | 'postgres'>('cluster');
  const groups = useMemo(() => {
    const by: Record<string, MonVM[]> = {};
    (m?.hosts ?? []).forEach((h) => (by[h.kind] ??= []).push(h));
    return KIND_ORDER.filter((k) => by[k]?.length).map((k) => [k, by[k]] as const);
  }, [m?.hosts]);

  if (q.isLoading) return <LinearProgress />;
  if (q.error) return <Alert severity="error">{t('monLoadFailed')}</Alert>;
  if (!m) return null;
  if (m.error) {
    return <Alert severity="warning">{t('monNoPrometheus', { url: m.prometheus || '—', error: m.error })}</Alert>;
  }

  const vms = m.hosts ?? [];
  const svcUp = (h: MonVM, svc: string) => h.services.find((x) => x.service === svc)?.up;
  const dbVMs = vms.filter((h) => h.kind === 'database');
  const pgUp = dbVMs.filter((h) => svcUp(h, 'postgres') ?? svcUp(h, 'patroni') ?? h.up).length;
  const etcdVMs = vms.filter((h) => h.services.some((x) => x.service === 'etcd'));
  const etcdUp = etcdVMs.filter((h) => svcUp(h, 'etcd')).length;
  const vmsDown = vms.filter((h) => !h.up);
  const firing = m.alerts.filter((a) => a.state === 'firing');
  const critical = firing.filter((a) => a.severity === 'critical').length;
  const statusTone: Tone = !clusterStatus
    ? 'unknown'
    : /healthy|ready|running/i.test(clusterStatus)
      ? 'good'
      : /fail|error|unavailable/i.test(clusterStatus)
        ? 'critical'
        : 'warning';
  const pgTone: Tone = !dbVMs.length ? 'unknown' : pgUp === dbVMs.length ? 'good' : pgUp ? 'warning' : 'critical';
  const etcdTone: Tone = !etcdVMs.length
    ? st.etcd_has_leader === undefined
      ? 'unknown'
      : st.etcd_has_leader
        ? 'good'
        : 'critical'
    : st.etcd_has_leader === 0 || etcdUp * 2 <= etcdVMs.length
      ? 'critical'
      : etcdUp < etcdVMs.length
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
          value={dbVMs.length ? `${pgUp} / ${dbVMs.length} ${t('monUp')}` : '—'}
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
            etcdVMs.length
              ? `${etcdUp} / ${etcdVMs.length} ${t('monUp')}`
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
          label={t('monMachines')}
          value={`${vms.length - vmsDown.length} / ${vms.length} ${t('monUp')}`}
          tone={!vms.length ? 'unknown' : vmsDown.length ? 'critical' : 'good'}
          sub={vmsDown.length ? t('monDown', { list: vmsDown.map((d) => d.name).join(', ') }) : t('monAllUp')}
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

      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40 }}>
        <Tab
          value="cluster"
          label={t('monTabCluster')}
          sx={{ minHeight: 40, textTransform: 'none', fontWeight: 700 }}
        />
        <Tab
          value="postgres"
          label={t('monTabPostgres')}
          sx={{ minHeight: 40, textTransform: 'none', fontWeight: 700 }}
        />
      </Tabs>

      {tab === 'cluster' ? (
        <>
          {/* machines by role: one entry per VM, its services de-duplicated over the scrape jobs */}
          <Section title={t('monMachinesTitle')}>
            <Box
              sx={{
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: {
                  xs: 'minmax(0, 1fr)',
                  md: 'repeat(2, minmax(0, 1fr))',
                  xl: 'repeat(3, minmax(0, 1fr))',
                },
              }}>
              {groups.map(([kind, list]) => {
                const ok = list.filter((h) => h.up).length;
                const tone: Tone = ok === list.length ? 'good' : ok ? 'warning' : 'critical';
                return (
                  <Box
                    key={kind}
                    sx={{
                      border: 1,
                      borderColor: tone === 'good' ? 'divider' : TONE[tone].color,
                      borderRadius: 2,
                      p: 1.5,
                      bgcolor: 'background.paper',
                    }}>
                    <Stack direction="row" alignItems="center" gap={0.75} mb={1}>
                      <Box sx={{ color: TONE[tone].color, display: 'flex' }}>{TONE[tone].icon}</Box>
                      <Typography fontWeight={700}>{t(`monKind_${kind}`)}</Typography>
                      <Typography variant="caption" color="text.secondary" ml="auto">
                        {ok} / {list.length} {t('monUp')}
                      </Typography>
                    </Stack>
                    <Stack gap={0.75}>
                      {list.map((h) => (
                        <Stack key={h.host} direction="row" alignItems="center" gap={1} flexWrap="wrap">
                          <Box sx={{ color: h.up ? 'success.main' : 'error.main', display: 'flex' }}>
                            {h.up ? (
                              <CheckCircleOutline sx={{ fontSize: 16 }} />
                            ) : (
                              <ErrorOutline sx={{ fontSize: 16 }} />
                            )}
                          </Box>
                          <Typography variant="body2" fontWeight={700}>
                            {h.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {h.name !== h.host ? h.host : ''}
                            {h.db_role ? ` · ${h.db_role}` : ''}
                          </Typography>
                          <Stack direction="row" gap={0.5} flexWrap="wrap" ml="auto">
                            {h.services.map((sv) => (
                              <Tooltip key={sv.service} title={`${t('monJobs')}: ${sv.jobs.join(', ')}`}>
                                <Chip
                                  size="small"
                                  variant="outlined"
                                  color={sv.up ? 'success' : 'error'}
                                  label={SERVICE_LABEL[sv.service] ?? sv.service}
                                  sx={{ height: 20, '& .MuiChip-label': { px: 0.75, fontSize: 11 } }}
                                />
                              </Tooltip>
                            ))}
                          </Stack>
                        </Stack>
                      ))}
                    </Stack>
                  </Box>
                );
              })}
            </Box>
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

          {hasData(m, ['etcd_db_size', 'etcd_fsync_p99', 'etcd_leader_changes']) || etcdVMs.length ? (
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
        </>
      ) : (
        <>
          {/* PostgreSQL instances */}
          <Section title={t('monInstances')}>
            <Box
              sx={{
                display: 'grid',
                gap: 1.5,
                gridTemplateColumns: {
                  xs: 'minmax(0, 1fr)',
                  md: 'repeat(2, minmax(0, 1fr))',
                  xl: 'repeat(3, minmax(0, 1fr))',
                },
              }}>
              {dbVMs.map((h) => {
                const pg = svcUp(h, 'postgres');
                const pat = svcUp(h, 'patroni');
                const tone: Tone = h.up ? 'good' : pg === false && pat === false ? 'critical' : 'warning';
                return (
                  <Box
                    key={h.host}
                    sx={{
                      border: 1,
                      borderColor: tone === 'good' ? 'divider' : TONE[tone].color,
                      borderRadius: 2,
                      p: 1.5,
                      bgcolor: 'background.paper',
                    }}>
                    <Stack direction="row" alignItems="center" gap={0.75}>
                      <Box sx={{ color: TONE[tone].color, display: 'flex' }}>{TONE[tone].icon}</Box>
                      <Typography fontWeight={700}>{h.name}</Typography>
                      {h.db_role ? (
                        <Chip
                          size="small"
                          color={/leader|master|primary/.test(h.db_role) ? 'primary' : 'default'}
                          label={h.db_role}
                          sx={{ height: 20 }}
                        />
                      ) : null}
                      <Typography variant="caption" color="text.secondary" ml="auto">
                        {h.host}
                      </Typography>
                    </Stack>
                    <Stack direction="row" gap={0.5} mt={1} flexWrap="wrap">
                      {h.services.map((sv) => (
                        <Chip
                          key={sv.service}
                          size="small"
                          variant="outlined"
                          color={sv.up ? 'success' : 'error'}
                          icon={sv.up ? <CheckCircleOutline /> : <ErrorOutline />}
                          label={SERVICE_LABEL[sv.service] ?? sv.service}
                        />
                      ))}
                    </Stack>
                  </Box>
                );
              })}
              {!dbVMs.length ? (
                <Typography variant="body2" color="text.secondary">
                  {t('monNoDbTargets')}
                </Typography>
              ) : null}
            </Box>
          </Section>

          <Section title={t('monPgGraphs')}>
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
                panel={
                  hasData(m, ['pg_replication_lag']) ? m.panels.pg_replication_lag : m.panels.pg_replication_lag_bytes
                }
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
              <ChartCard
                title={t('monDeadlocks')}
                panel={m.panels.pg_deadlocks}
                format={(v) => compact(v)}
                empty={empty}
              />
            </Grid>
          </Section>
        </>
      )}

      <Typography variant="caption" color="text.secondary">
        {t('monFooter', { url: m.prometheus, date: new Date(m.generated_at).toLocaleTimeString() })}
      </Typography>
    </Stack>
  );
};

export default MonitoringDashboard;
