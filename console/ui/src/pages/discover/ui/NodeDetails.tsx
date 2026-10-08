import { FC, ReactNode, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
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
import { useTranslation } from 'react-i18next';
import { DNode, DResult } from '@shared/api/api/discover.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import { roleKey, useRoleColors } from './Topology.tsx';

const Fact: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <Box sx={{ minWidth: 0 }}>
    <Typography variant="caption" color="text.secondary" component="div">
      {label}
    </Typography>
    <Typography variant="body2" fontWeight={600} sx={{ wordBreak: 'break-word' }} component="div">
      {children || '—'}
    </Typography>
  </Box>
);

const Empty: FC<{ text: string }> = ({ text }) => (
  <Typography variant="body2" color="text.secondary" py={1}>
    {text}
  </Typography>
);

const uptime = (started?: string) => {
  if (!started) return '';
  const d = (Date.now() - new Date(started.replace(' ', 'T')).getTime()) / 86400000;
  if (!Number.isFinite(d)) return '';
  return d >= 1 ? `${Math.floor(d)} d` : `${Math.round(d * 24)} h`;
};

/** Everything found on one server, in tabs. */
const NodeDetails: FC<{ node: DNode; result: DResult }> = ({ node: n, result }) => {
  const { t } = useTranslation('discover');
  const colors = useRoleColors();
  const [tab, setTab] = useState('overview');
  const [filter, setFilter] = useState('');
  const key = roleKey(n);
  const color = colors[key as keyof typeof colors] ?? colors.unknown;
  const name = (id: string) => result.nodes.find((x) => x.id === id)?.name ?? id;
  const ins = result.edges.filter((e) => e.to === n.id);
  const outs = result.edges.filter((e) => e.from === n.id);
  const conns = Object.entries(n.connections ?? {});
  const totalConns = conns.reduce((s, [, v]) => s + v, 0);

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper', minWidth: 0 }}>
      <Stack direction="row" alignItems="center" gap={1.5} px={2} pt={1.5} flexWrap="wrap">
        <Box sx={{ width: 10, height: 34, borderRadius: 1, bgcolor: color }} />
        <Box flex={1} minWidth={0}>
          <Typography fontWeight={700}>{n.name || n.host}</Typography>
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: '"JetBrains Mono", monospace' }}>
            {n.host}
            {n.port ? `:${n.port}` : ''}
          </Typography>
        </Box>
        <Chip size="small" label={t(`role_${key}`)} sx={{ bgcolor: color, color: '#fff', fontWeight: 700 }} />
        {n.version ? <Chip size="small" variant="outlined" label={n.version} /> : null}
        {(n.stack ?? []).map((s) => (
          <Chip key={s} size="small" variant="outlined" label={s} />
        ))}
      </Stack>
      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        sx={{ px: 1, borderBottom: 1, borderColor: 'divider', minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
        <Tab value="overview" label={t('tab_overview')} />
        <Tab value="replication" label={t('tab_replication')} disabled={!n.reachable} />
        <Tab value="databases" label={`${t('tab_databases')} (${n.databases?.length ?? 0})`} disabled={!n.reachable} />
        <Tab value="settings" label={t('tab_settings')} disabled={!n.reachable} />
        <Tab value="roles" label={`${t('tab_roles')} (${n.roles?.length ?? 0})`} disabled={!n.reachable} />
      </Tabs>
      <Box p={2}>
        {!n.reachable ? (
          <Alert severity={n.external ? 'info' : 'error'}>
            {n.external ? t('externalHelp', { role: t(`role_${key}`) }) : n.error}
          </Alert>
        ) : null}

        {tab === 'overview' ? (
          <Stack gap={2} mt={n.reachable ? 0 : 2}>
            {n.reachable ? (
              <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(4, 1fr)' } }}>
                <Fact label={t('f_role')}>{t(`role_${key}`)}</Fact>
                <Fact label={t('f_version')}>{n.version}</Fact>
                <Fact label={t('f_uptime')}>
                  {uptime(n.started_at)}{' '}
                  <Typography component="span" variant="caption" color="text.secondary">
                    {n.started_at ? `(${new Date(n.started_at.replace(' ', 'T')).toLocaleString()})` : ''}
                  </Typography>
                </Fact>
                <Fact label={t('f_connections')}>
                  {totalConns} / {n.max_connections ?? '—'}
                </Fact>
                <Fact label={t('f_system_id')}>{n.system_id}</Fact>
                <Fact label={t('f_timeline')}>{n.timeline ? String(n.timeline) : ''}</Fact>
                <Fact label={t('f_server_addr')}>{n.server_addr}</Fact>
                <Fact label={t('f_login')}>{n.login_is_superuser ? t('superuser') : t('notSuperuser')}</Fact>
                <Fact label={t('f_data_dir')}>{n.settings?.find((s) => s.name === 'data_directory')?.value ?? ''}</Fact>
                <Fact label={t('f_wal_level')}>{n.settings?.find((s) => s.name === 'wal_level')?.value ?? ''}</Fact>
                <Fact label={t('f_sync')}>
                  {n.settings?.find((s) => s.name === 'synchronous_standby_names')?.value || t('none')}
                </Fact>
                <Fact label={t('f_archive')}>{n.settings?.find((s) => s.name === 'archive_mode')?.value ?? ''}</Fact>
              </Box>
            ) : null}
            {n.patroni ? (
              <Alert severity="info" icon={false}>
                <b>Patroni</b> {n.patroni.version} · {t('scope')} <b>{n.patroni.scope}</b> · {n.patroni.role} ·{' '}
                {n.patroni.state} · {n.patroni.url}
              </Alert>
            ) : null}
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('receivesFrom')}
                </Typography>
                {ins.length ? (
                  ins.map((e, i) => (
                    <Typography key={i} variant="body2">
                      {e.kind === 'streaming' ? t('streamingFrom') : t('logicalFrom')} <b>{name(e.from)}</b>
                      {e.label ? ` · ${e.label}` : ''} · {e.state}
                    </Typography>
                  ))
                ) : (
                  <Empty text={t('nothing')} />
                )}
              </Box>
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('sendsTo')}
                </Typography>
                {outs.length ? (
                  outs.map((e, i) => (
                    <Typography key={i} variant="body2">
                      {e.kind === 'streaming' ? t('streamingTo') : t('logicalTo')} <b>{name(e.to)}</b>
                      {e.label ? ` · ${e.label}` : ''} · {e.sync || e.state} · {t('lag', { value: bytes(e.lag_bytes) })}
                    </Typography>
                  ))
                ) : (
                  <Empty text={t('nothing')} />
                )}
              </Box>
            </Box>
            {conns.length ? (
              <Stack direction="row" gap={1} flexWrap="wrap">
                {conns.map(([k, v]) => (
                  <Chip key={k} size="small" variant="outlined" label={`${k}: ${v}`} />
                ))}
              </Stack>
            ) : null}
            {n.partial?.length ? (
              <Alert severity="warning">
                <b>{t('partialTitle')}</b>
                <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
                  {n.partial.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </Box>
              </Alert>
            ) : null}
          </Stack>
        ) : null}

        {tab === 'replication' ? (
          <Stack gap={2.5}>
            {n.receiver ? (
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('upstream')}
                </Typography>
                <Typography variant="body2">
                  {n.receiver.sender_host}:{n.receiver.sender_port} · {n.receiver.status}
                  {n.receiver.slot_name ? ` · ${t('slot')} ${n.receiver.slot_name}` : ''}
                  {n.receiver.from_config ? ` · ${t('fromConfig')}` : ''}
                </Typography>
              </Box>
            ) : null}
            <MiniTable
              title={t('senders')}
              empty={t('noSenders')}
              head={[
                t('c_client'),
                t('c_application'),
                t('c_kind'),
                t('c_state'),
                t('c_sync'),
                t('c_slot'),
                t('c_lag'),
              ]}
              rows={(n.senders ?? []).map((s) => [
                s.client_addr,
                s.application_name,
                s.kind,
                s.state,
                s.sync_state,
                s.slot_name ?? '',
                `${bytes(s.lag_bytes)}${s.replay_lag_seconds ? ` · ${s.replay_lag_seconds.toFixed(2)} s` : ''}`,
              ])}
            />
            <MiniTable
              title={t('slots')}
              empty={t('noSlots')}
              head={[
                t('c_name'),
                t('c_kind'),
                t('c_database'),
                t('c_plugin'),
                t('c_active'),
                t('c_retained'),
                t('c_wal'),
              ]}
              rows={(n.slots ?? []).map((s) => [
                s.name,
                s.type,
                s.database ?? '',
                s.plugin ?? '',
                s.active ? t('yes') : t('no'),
                bytes(s.retained_bytes),
                s.wal_status ?? '',
              ])}
            />
            <MiniTable
              title={t('subscriptions')}
              empty={t('noSubscriptions')}
              head={[t('c_name'), t('c_database'), t('c_publications'), t('c_publisher'), t('c_state'), t('c_tables')]}
              rows={(n.subscriptions ?? []).map((s) => [
                s.name,
                s.database,
                (s.publications ?? []).join(', '),
                s.publisher_host ? `${s.publisher_host}:${s.publisher_port} / ${s.publisher_db ?? ''}` : t('hidden'),
                !s.enabled ? t('disabled') : s.receiving ? t('receiving') : t('notReceiving'),
                s.tables ? `${s.tables_ready} / ${s.tables}` : '',
              ])}
            />
          </Stack>
        ) : null}

        {tab === 'databases' ? (
          <MiniTable
            empty={t('noDatabases')}
            head={[t('c_name'), t('c_owner'), t('c_size'), t('c_tables'), t('c_extensions'), t('c_publications')]}
            rows={(n.databases ?? []).map((d) => [
              d.name,
              d.owner,
              bytes(d.size_bytes),
              String(d.tables),
              (d.extensions ?? []).join(', ') || (d.error ? d.error : '—'),
              (d.publications ?? [])
                .map((p) => `${p.name} (${p.all_tables ? t('allTables') : (p.tables ?? []).join(', ')})`)
                .join('; ') || '—',
            ])}
          />
        ) : null}

        {tab === 'settings' ? (
          <Stack gap={1}>
            <TextField
              size="small"
              placeholder={t('filter')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              sx={{ maxWidth: 320 }}
            />
            <MiniTable
              empty={t('noSettings')}
              head={[t('c_name'), t('c_value')]}
              mono
              rows={(n.settings ?? [])
                .filter((s) => !filter || s.name.includes(filter.toLowerCase()))
                .map((s) => [s.name, `${s.value}${s.unit ? ` ${s.unit}` : ''}`])}
            />
          </Stack>
        ) : null}

        {tab === 'roles' ? (
          <MiniTable
            empty={t('noRoles')}
            head={[t('c_name'), t('c_attributes'), t('c_valid_until')]}
            rows={(n.roles ?? []).map((r) => [
              r.name,
              [
                r.superuser && 'superuser',
                r.replication && 'replication',
                r.login ? 'login' : 'no login',
                r.createdb && 'createdb',
                r.createrole && 'createrole',
              ]
                .filter(Boolean)
                .join(', '),
              r.valid_until ?? '',
            ])}
          />
        ) : null}
      </Box>
    </Box>
  );
};

const MiniTable: FC<{ title?: string; head: string[]; rows: string[][]; empty: string; mono?: boolean }> = ({
  title,
  head,
  rows,
  empty,
  mono,
}) => (
  <Box>
    {title ? (
      <Typography variant="body2" fontWeight={700} mb={0.5}>
        {title}
      </Typography>
    ) : null}
    {rows.length ? (
      <TableContainer sx={{ maxHeight: 460 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {head.map((h) => (
                <TableCell key={h}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={i} hover>
                {r.map((v, j) => (
                  <TableCell
                    key={j}
                    sx={{
                      fontFamily: mono || j === 0 ? '"JetBrains Mono", monospace' : undefined,
                      fontSize: mono || j === 0 ? 12 : undefined,
                      wordBreak: 'break-word',
                      maxWidth: 420,
                    }}>
                    {v}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    ) : (
      <Empty text={empty} />
    )}
  </Box>
);

export default NodeDetails;
