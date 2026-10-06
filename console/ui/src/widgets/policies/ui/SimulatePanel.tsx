import { FC, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import BlockOutlined from '@mui/icons-material/BlockOutlined';
import ScienceOutlined from '@mui/icons-material/ScienceOutlined';
import { useTranslation } from 'react-i18next';
import { PermissionInfo, SimulateResult, usePostSimulateMutation } from '@shared/api/api/access.ts';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { PERMISSION_GROUPS } from '../lib/policyText.ts';

interface Props {
  users: string[];
  clusters: { id: number; name: string }[];
  catalog: PermissionInfo[];
}

/** "Test access": what would this user be allowed to do, on this cluster, from this IP, at this time - and why. */
const SimulatePanel: FC<Props> = ({ users, clusters, catalog }) => {
  const { t } = useTranslation('settings');
  const [simulate, state] = usePostSimulateMutation();
  const [form, setForm] = useState({ username: '', cluster_id: 0, database: '', client_ip: '', at: '' });
  const [res, setRes] = useState<SimulateResult | null>(null);

  const run = async () => {
    try {
      setRes(
        await simulate({
          username: form.username,
          cluster_id: form.cluster_id || undefined,
          database: form.database || undefined,
          client_ip: form.client_ip || undefined,
          at: form.at ? new Date(form.at).toISOString() : undefined,
        }).unwrap(),
      );
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const describe = Object.fromEntries(catalog.map((c) => [c.name, c]));
  const sql = res?.sql;

  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2 }}>
      <Stack direction="row" alignItems="center" gap={1} mb={0.5}>
        <ScienceOutlined fontSize="small" color="primary" />
        <Typography fontWeight={700}>{t('testAccess')}</Typography>
      </Stack>
      <Typography variant="caption" color="text.secondary" component="div" mb={1.5}>
        {t('testAccessHint')}
      </Typography>
      <Stack direction={{ xs: 'column', md: 'row' }} gap={1.5} alignItems={{ md: 'center' }} flexWrap="wrap">
        <Autocomplete
          size="small"
          options={users}
          value={form.username || null}
          onChange={(_, v) => setForm({ ...form, username: v ?? '' })}
          renderInput={(params) => <TextField {...params} label={t('username', { ns: 'shared' })} />}
          sx={{ minWidth: 200 }}
        />
        <TextField
          select
          size="small"
          label={t('cluster')}
          value={form.cluster_id}
          onChange={(e) => setForm({ ...form, cluster_id: Number(e.target.value) })}
          sx={{ minWidth: 200 }}>
          <MenuItem value={0}>{t('noCluster')}</MenuItem>
          {clusters.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          size="small"
          label={t('database')}
          value={form.database}
          onChange={(e) => setForm({ ...form, database: e.target.value })}
          sx={{ width: 150 }}
        />
        <TextField
          size="small"
          label={t('clientIp')}
          value={form.client_ip}
          onChange={(e) => setForm({ ...form, client_ip: e.target.value })}
          sx={{ width: 150 }}
        />
        <TextField
          size="small"
          type="datetime-local"
          label={t('atTime')}
          value={form.at}
          onChange={(e) => setForm({ ...form, at: e.target.value })}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <Button variant="outlined" disabled={!form.username || state.isLoading} onClick={run}>
          {t('check')}
        </Button>
      </Stack>

      {res ? (
        <Stack gap={2} mt={2}>
          <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
            <Typography variant="body2" fontWeight={700}>
              {res.username}
            </Typography>
            {Object.entries(res.attributes ?? {}).map(([k, v]) => (
              <Chip key={k} size="small" variant="outlined" label={`${k} = ${v}`} />
            ))}
          </Stack>
          <Stack direction={{ xs: 'column', lg: 'row' }} gap={2} alignItems="flex-start">
            <Box flex={1} minWidth={0}>
              {PERMISSION_GROUPS.map((g) => (
                <Box key={g.label} mb={1}>
                  <Typography variant="overline" color="text.secondary">
                    {g.label}
                  </Typography>
                  <Stack direction="row" gap={0.75} flexWrap="wrap">
                    {g.perms.map((perm) => {
                      const d = res.decisions[perm];
                      if (!d) return null;
                      return (
                        <Tooltip
                          key={perm}
                          title={
                            <>
                              <b>{describe[perm]?.description ?? perm}</b>
                              <br />
                              {d.reason}
                              {d.policy ? ` (${d.policy})` : ''}
                            </>
                          }>
                          <Chip
                            size="small"
                            color={d.allowed ? 'success' : 'default'}
                            variant={d.allowed ? 'filled' : 'outlined'}
                            icon={d.allowed ? <CheckCircleOutline /> : <BlockOutlined />}
                            label={perm}
                          />
                        </Tooltip>
                      );
                    })}
                  </Stack>
                </Box>
              ))}
            </Box>
            <Box flex={1} minWidth={0}>
              {sql ? (
                <Box mb={1.5}>
                  <Typography variant="overline" color="text.secondary">
                    {t('sqlProfile')}
                  </Typography>
                  {sql.level === 'none' ? (
                    <Alert severity="warning">{sql.note || t('noSqlAccess')}</Alert>
                  ) : (
                    <Table size="small">
                      <TableBody>
                        <TableRow>
                          <TableCell>{t('sqlLevel')}</TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              label={sql.level}
                              color={sql.level === 'admin' ? 'warning' : 'primary'}
                            />
                            {sql.stats ? <Chip size="small" label="stats" sx={{ ml: 0.5 }} /> : null}
                          </TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>{t('databases')}</TableCell>
                          <TableCell>{sql.databases?.length ? sql.databases.join(', ') : t('all')}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>{t('schemas')}</TableCell>
                          <TableCell>{sql.schemas?.length ? sql.schemas.join(', ') : t('all')}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>{t('tables')}</TableCell>
                          <TableCell>{sql.tables?.length ? sql.tables.join(', ') : t('all')}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>{t('hiddenColumns')}</TableCell>
                          <TableCell>{sql.hidden_columns?.length ? sql.hidden_columns.join(', ') : '—'}</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell>{t('limits')}</TableCell>
                          <TableCell>
                            {sql.max_rows ? `${sql.max_rows} ${t('rows')}` : t('noRowLimit')}
                            {sql.timeout_seconds ? ` · ${sql.timeout_seconds}s` : ''}
                          </TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  )}
                  {sql.note && sql.level !== 'none' ? (
                    <Alert severity="info" sx={{ mt: 1 }}>
                      {sql.note}
                    </Alert>
                  ) : null}
                </Box>
              ) : null}
              <Typography variant="overline" color="text.secondary">
                {t('policiesConsidered')}
              </Typography>
              <Table size="small">
                <TableBody>
                  {res.policies.map((m) => (
                    <TableRow key={m.policy}>
                      <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{m.policy}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant={m.applies ? 'filled' : 'outlined'}
                          color={m.applies ? (m.effect === 'deny' ? 'error' : 'success') : 'default'}
                          label={m.applies ? t(m.effect === 'deny' ? 'effectDeny' : 'effectAllow') : t('notApplied')}
                        />
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>{m.why}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          </Stack>
        </Stack>
      ) : null}
    </Box>
  );
};

export default SimulatePanel;
