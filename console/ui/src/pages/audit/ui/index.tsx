import { FC, Fragment, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Chip,
  Collapse,
  IconButton,
  LinearProgress,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import KeyboardArrowDown from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRight from '@mui/icons-material/KeyboardArrowRight';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { AuditEvent, AuditQuery, useGetAuditQuery } from '@shared/api/api/access.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { useGetUsersQuery } from '@shared/api/api/auth.ts';
import { can } from '@shared/lib/session.ts';

const ACTIONS = [
  'auth',
  'sql',
  'logs',
  'patroni',
  'clusters',
  'operations',
  'users',
  'policies',
  'settings',
  'secrets',
  'projects',
  'environments',
  'servers',
  'audit',
];

const RANGES: Record<string, number> = { '1h': 3600, '24h': 86400, '7d': 7 * 86400, '30d': 30 * 86400 };

const outcomeColor = (o: string) => (o === 'ok' ? 'success' : o === 'denied' ? 'warning' : 'error');

const DetailRow: FC<{ e: AuditEvent; cluster?: string }> = ({ e, cluster }) => {
  const d = (e.details ?? {}) as Record<string, unknown>;
  const statement = typeof d.statement === 'string' ? d.statement : typeof d.sql === 'string' ? d.sql : '';
  const rest = Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'statement' && k !== 'sql'));
  return (
    <Stack gap={1} py={1}>
      <Stack direction="row" gap={2} flexWrap="wrap">
        <Typography variant="body2">
          <b>{e.method}</b> <span style={{ fontFamily: 'monospace' }}>{e.path}</span>
        </Typography>
        {e.status ? <Typography variant="body2">HTTP {e.status}</Typography> : null}
        {cluster ? <Typography variant="body2">cluster {cluster}</Typography> : null}
      </Stack>
      {statement ? (
        <Box
          component="pre"
          sx={{
            m: 0,
            p: 1.5,
            borderRadius: 1,
            bgcolor: 'action.hover',
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 240,
            overflow: 'auto',
          }}>
          {statement}
        </Box>
      ) : null}
      {Object.keys(rest).length ? (
        <Stack direction="row" gap={0.75} flexWrap="wrap">
          {Object.entries(rest).map(([k, v]) => (
            <Chip
              key={k}
              size="small"
              variant="outlined"
              label={`${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`}
              sx={{ maxWidth: '100%', height: 'auto', '& .MuiChip-label': { whiteSpace: 'normal', py: 0.25 } }}
            />
          ))}
        </Stack>
      ) : null}
    </Stack>
  );
};

/** JumboSQL: who did what, when, from where - every change, every SQL statement, every refusal. */
const AuditLog: FC = () => {
  const { t } = useTranslation(['shared', 'settings']);
  const projectId = useAppSelector(selectCurrentProject);
  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId },
  );
  const users = useGetUsersQuery(undefined, { skip: !can('users.manage') });

  const [filters, setFilters] = useState({ username: '', action: '', outcome: '', cluster_id: 0, range: '24h', q: '' });
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(50);
  const [openId, setOpenId] = useState<number | null>(null);
  // "from" is fixed when the filters change, so polling doesn't refetch a moving window
  const [anchor, setAnchor] = useState(() => Date.now());

  const query: AuditQuery = useMemo(
    () => ({
      username: filters.username || undefined,
      action: filters.action || undefined,
      outcome: filters.outcome || undefined,
      cluster_id: filters.cluster_id || undefined,
      q: filters.q || undefined,
      from: filters.range !== 'all' ? new Date(anchor - RANGES[filters.range] * 1000).toISOString() : undefined,
      limit: rows,
      offset: page * rows,
    }),
    [filters, rows, page, anchor],
  );
  const audit = useGetAuditQuery(query, { pollingInterval: page === 0 ? 15000 : 0 });

  const clusterName = useMemo(
    () => Object.fromEntries((clusters.data?.data ?? []).map((c) => [c.id, c.name])),
    [clusters.data],
  );
  const set = (patch: Partial<typeof filters>) => {
    setFilters({ ...filters, ...patch });
    setPage(0);
    setAnchor(Date.now());
  };

  const data = audit.data?.data ?? [];
  const total = audit.data?.total ?? data.length + page * rows + (data.length === rows ? 1 : 0);

  return (
    <Stack gap={2} p={2}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={2}>
        <Box>
          <Typography variant="h6">{t('auditLog')}</Typography>
          <Typography variant="body2" color="text.secondary" maxWidth={820}>
            {t('auditLogHelp')}
          </Typography>
        </Box>
        <Tooltip title={t('refresh')}>
          <IconButton
            onClick={() => {
              setAnchor(Date.now());
              audit.refetch();
            }}>
            <RefreshIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
        <Autocomplete
          freeSolo
          size="small"
          options={(users.data ?? []).map((u) => u.username)}
          value={filters.username}
          onInputChange={(_, v, reason) => reason !== 'reset' && set({ username: v })}
          onChange={(_, v) => set({ username: v ?? '' })}
          renderInput={(params) => <TextField {...params} label={t('user')} />}
          sx={{ width: 180 }}
        />
        <TextField
          select
          size="small"
          label={t('action')}
          value={filters.action}
          onChange={(e) => set({ action: e.target.value })}
          sx={{ width: 160 }}>
          <MenuItem value="">{t('all', { ns: 'settings' })}</MenuItem>
          {ACTIONS.map((a) => (
            <MenuItem key={a} value={a}>
              {a}.*
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('outcome')}
          value={filters.outcome}
          onChange={(e) => set({ outcome: e.target.value })}
          sx={{ width: 140 }}>
          <MenuItem value="">{t('all', { ns: 'settings' })}</MenuItem>
          <MenuItem value="ok">ok</MenuItem>
          <MenuItem value="denied">denied</MenuItem>
          <MenuItem value="error">error</MenuItem>
        </TextField>
        <TextField
          select
          size="small"
          label={t('cluster', { ns: 'settings' })}
          value={filters.cluster_id}
          onChange={(e) => set({ cluster_id: Number(e.target.value) })}
          sx={{ width: 180 }}>
          <MenuItem value={0}>{t('all', { ns: 'settings' })}</MenuItem>
          {(clusters.data?.data ?? []).map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('period')}
          value={filters.range}
          onChange={(e) => set({ range: e.target.value })}
          sx={{ width: 140 }}>
          {Object.keys(RANGES).map((r) => (
            <MenuItem key={r} value={r}>
              {t(`last_${r}`)}
            </MenuItem>
          ))}
          <MenuItem value="all">{t('allTime')}</MenuItem>
        </TextField>
        <TextField
          size="small"
          label={t('search')}
          placeholder={t('auditSearchHint')}
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
          sx={{ flex: 1, minWidth: 200 }}
        />
      </Stack>

      {audit.error ? <Alert severity="error">{t('auditLoadFailed')}</Alert> : null}
      <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2 }}>
        {audit.isFetching ? <LinearProgress sx={{ height: 2 }} /> : <Box height={2} />}
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell width={32} />
                <TableCell>{t('time')}</TableCell>
                <TableCell>{t('user')}</TableCell>
                <TableCell>{t('clientIp', { ns: 'settings' })}</TableCell>
                <TableCell>{t('action')}</TableCell>
                <TableCell>{t('cluster', { ns: 'settings' })}</TableCell>
                <TableCell>{t('outcome')}</TableCell>
                <TableCell>{t('summary')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.map((e) => {
                const open = openId === e.id;
                const d = (e.details ?? {}) as Record<string, unknown>;
                const summary = String(d.sql ?? d.statement ?? d.reason ?? d.error ?? d.file ?? '').split('\n')[0];
                return (
                  <Fragment key={e.id}>
                    <TableRow
                      hover
                      sx={{ cursor: 'pointer', '& > td': { borderBottom: open ? 0 : undefined } }}
                      onClick={() => setOpenId(open ? null : e.id)}>
                      <TableCell padding="none" align="center">
                        {open ? <KeyboardArrowDown fontSize="small" /> : <KeyboardArrowRight fontSize="small" />}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString()}</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>{e.username}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{e.client_ip || '—'}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{e.action}</TableCell>
                      <TableCell>{e.cluster_id ? (clusterName[e.cluster_id] ?? `#${e.cluster_id}`) : '—'}</TableCell>
                      <TableCell>
                        <Chip size="small" color={outcomeColor(e.outcome)} label={e.outcome} />
                      </TableCell>
                      <TableCell
                        sx={{
                          maxWidth: 420,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          fontFamily: d.sql || d.statement ? 'monospace' : undefined,
                          fontSize: 12,
                          color: 'text.secondary',
                        }}>
                        {summary}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 0 }}>
                        <Collapse in={open} unmountOnExit>
                          <DetailRow e={e} cluster={e.cluster_id ? clusterName[e.cluster_id] : undefined} />
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
              {!data.length && !audit.isFetching ? (
                <TableRow>
                  <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    {t('noAuditEvents')}
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination
          component="div"
          count={total}
          page={page}
          onPageChange={(_, p) => setPage(p)}
          rowsPerPage={rows}
          rowsPerPageOptions={[25, 50, 100, 200]}
          onRowsPerPageChange={(e) => {
            setRows(Number(e.target.value));
            setPage(0);
          }}
        />
      </Box>
    </Stack>
  );
};

export default AuditLog;
