import { FC, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import StorageRounded from '@mui/icons-material/StorageRounded';
import CloudOutlined from '@mui/icons-material/CloudOutlined';
import LanOutlined from '@mui/icons-material/LanOutlined';
import FolderSharedOutlined from '@mui/icons-material/FolderSharedOutlined';
import AddRounded from '@mui/icons-material/AddRounded';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import LockOutlined from '@mui/icons-material/LockOutlined';
import ScheduleRounded from '@mui/icons-material/ScheduleRounded';
import { useTranslation } from 'react-i18next';
import { BJobRequest, BRepo, BRepoDef, BStatus } from '@shared/api/api/backup.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import { when } from './Timeline.tsx';

/** KeenPG Backup & Restore: the repositories (a disk, S3, Azure, GCS, SFTP), adding one, and a backup running now. */

export const repoIcon = (type?: string) =>
  type === 's3' || type === 'azure' || type === 'gcs' ? (
    <CloudOutlined />
  ) : type === 'sftp' ? (
    <LanOutlined />
  ) : type === 'cifs' ? (
    <FolderSharedOutlined />
  ) : (
    <StorageRounded />
  );

/** "Repo 2 · S3" */
export const repoName = (r: Pick<BRepo, 'index' | 'type'>, t: (k: string) => string) =>
  `${t('rp_repo')} ${r.index} · ${t(`rp_t_${r.type}`)}`;

/** where it is: a path, a bucket, a container */
const repoWhere = (r: BRepo) =>
  r.type === 'posix' || r.type === 'cifs'
    ? `${r.host ? `${r.host}:` : ''}${r.path ?? ''}`
    : `${r.bucket ?? ''}${r.endpoint ? ` @ ${r.endpoint}` : ''}${r.path && r.path !== '/var/lib/pgbackrest' ? ` ${r.path}` : ''}`;

export const RepoCards: FC<{
  status: BStatus;
  busy: boolean;
  start: (b: BJobRequest) => Promise<void>;
}> = ({ status, busy, start }) => {
  const { t } = useTranslation('backup');
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<BRepo | null>(null);
  const repos = status.repos ?? [];
  return (
    <>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
        {repos.map((r) => {
          const bad = r.status && r.status.code !== 0;
          const used = r.total_bytes && r.free_bytes !== undefined ? 1 - r.free_bytes / r.total_bytes : undefined;
          return (
            <Box
              key={r.key}
              sx={{
                p: 1.75,
                borderRadius: '14px',
                border: 1,
                borderColor: bad ? 'error.main' : 'divider',
                bgcolor: 'background.paper',
                position: 'relative',
                overflow: 'hidden',
                '&::after': {
                  content: '""',
                  position: 'absolute',
                  inset: 'auto 0 0 0',
                  height: 3,
                  bgcolor: bad ? 'error.main' : 'primary.main',
                },
              }}>
              <Stack direction="row" gap={1.25} alignItems="center">
                <Box
                  sx={{
                    width: 38,
                    height: 38,
                    borderRadius: '11px',
                    display: 'grid',
                    placeItems: 'center',
                    color: 'primary.main',
                    bgcolor: 'primary.lighter10',
                  }}>
                  {repoIcon(r.type)}
                </Box>
                <Box minWidth={0} flex={1}>
                  <Stack direction="row" alignItems="center" gap={0.75}>
                    <Typography fontWeight={800} noWrap>
                      {repoName(r, t)}
                    </Typography>
                    {r.cipher && r.cipher !== 'none' ? (
                      <Tooltip title={t('rp_encrypted')}>
                        <LockOutlined sx={{ fontSize: 16, color: 'success.main' }} />
                      </Tooltip>
                    ) : null}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" noWrap display="block" title={repoWhere(r)}>
                    {repoWhere(r) || '—'}
                  </Typography>
                </Box>
                <Chip
                  size="small"
                  color={bad ? 'error' : 'success'}
                  variant="outlined"
                  label={bad ? r.status?.message : t('rp_ok')}
                  sx={{ maxWidth: 130 }}
                />
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1, mt: 1.25 }}>
                {[
                  [t('rp_backups'), String(r.backups ?? 0)],
                  [t('rp_stored'), bytes(r.bytes ?? 0)],
                  [t('rp_last'), r.last ? t('rp_ago', { age: since(r.last) }) : '—'],
                ].map(([k, v]) => (
                  <Box key={k} minWidth={0}>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {k}
                    </Typography>
                    <Typography fontWeight={800} fontSize={15} noWrap title={k === t('rp_last') && r.last ? when(r.last) : v}>
                      {v}
                    </Typography>
                  </Box>
                ))}
              </Box>
              {used !== undefined ? (
                <Box mt={1}>
                  <LinearProgress
                    variant="determinate"
                    value={used * 100}
                    color={used > 0.85 ? 'error' : used > 0.7 ? 'warning' : 'primary'}
                    sx={{ height: 6, borderRadius: 3 }}
                  />
                  <Typography variant="caption" color="text.secondary">
                    {t('rp_free', { free: bytes(r.free_bytes ?? 0) })}
                  </Typography>
                </Box>
              ) : null}
              <Stack direction="row" gap={0.5} mt={1} alignItems="center">
                <Typography variant="caption" color="text.secondary" flex={1}>
                  {r.retention_full ? t('rp_keeps', { n: r.retention_full }) : t('rp_keepsAll')}
                </Typography>
                {r.managed ? (
                  <Button size="small" color="error" startIcon={<DeleteOutline />} disabled={busy} onClick={() => setRemoving(r)}>
                    {t('rp_remove')}
                  </Button>
                ) : null}
              </Stack>
            </Box>
          );
        })}
        <Box
          role="button"
          tabIndex={0}
          onClick={() => !busy && setAdding(true)}
          onKeyDown={(e) => e.key === 'Enter' && !busy && setAdding(true)}
          sx={{
            p: 1.75,
            minHeight: 150,
            borderRadius: '14px',
            border: '2px dashed',
            borderColor: 'divider',
            display: 'grid',
            placeItems: 'center',
            cursor: busy ? 'default' : 'pointer',
            color: 'text.secondary',
            opacity: busy ? 0.5 : 1,
            transition: 'border-color .15s, color .15s',
            '&:hover': busy ? {} : { borderColor: 'primary.main', color: 'primary.main' },
          }}>
          <Stack alignItems="center" gap={0.5}>
            <AddRounded sx={{ fontSize: 30 }} />
            <Typography fontWeight={800}>{t('rp_add')}</Typography>
            <Typography variant="caption" textAlign="center">
              {t('rp_addHint')}
            </Typography>
          </Stack>
        </Box>
      </Box>
      <AddRepoDialog
        open={adding}
        onClose={() => setAdding(false)}
        status={status}
        onAdd={async (index, def) => {
          setAdding(false);
          await start({ action: 'repo-add', index, repo_def: def });
        }}
      />
      <Dialog open={!!removing} onClose={() => setRemoving(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{removing ? t('rp_removeTitle', { name: repoName(removing, t) }) : ''}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">{t('rp_removeText')}</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRemoving(null)}>{t('cancel', { ns: 'upgrade' })}</Button>
          <Button
            color="error"
            variant="contained"
            onClick={() => {
              const r = removing;
              setRemoving(null);
              if (r) void start({ action: 'repo-remove', index: r.index });
            }}>
            {t('rp_remove')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

const TYPES = ['posix', 's3', 'azure', 'gcs', 'sftp', 'cifs'] as const;
type F = { k: string; secret?: boolean; ph?: string; req?: boolean };
const FIELDS: Record<(typeof TYPES)[number], F[]> = {
  posix: [{ k: 'path', ph: '/backup/pgbackrest', req: true }],
  cifs: [{ k: 'path', ph: '/mnt/backup/pgbackrest', req: true }],
  s3: [
    { k: 'endpoint', ph: 's3.ap-south-1.amazonaws.com', req: true },
    { k: 'bucket', ph: 'my-pg-backups', req: true },
    { k: 'region', ph: 'ap-south-1', req: true },
    { k: 'path', ph: '/pgbackrest' },
    { k: 'key', req: true },
    { k: 'secret', secret: true, req: true },
    { k: 'port', ph: '443' },
  ],
  azure: [
    { k: 'account', req: true },
    { k: 'container', req: true },
    { k: 'key', secret: true, req: true },
    { k: 'path', ph: '/pgbackrest' },
  ],
  gcs: [
    { k: 'bucket', req: true },
    { k: 'key', ph: '/etc/pgbackrest/gcs-key.json' },
    { k: 'path', ph: '/pgbackrest' },
  ],
  sftp: [
    { k: 'host', ph: 'backup.example.com', req: true },
    { k: 'user', ph: 'pgbackrest', req: true },
    { k: 'private_key', ph: '/var/lib/pgsql/.ssh/id_ed25519', req: true },
    { k: 'path', ph: '/backup/pgbackrest', req: true },
    { k: 'port', ph: '22' },
  ],
};

export const AddRepoDialog: FC<{
  open: boolean;
  onClose: () => void;
  status: BStatus;
  onAdd: (index: number, def: BRepoDef) => Promise<void>;
}> = ({ open, onClose, status, onAdd }) => {
  const { t } = useTranslation('backup');
  const [type, setType] = useState<(typeof TYPES)[number]>('s3');
  const [v, setV] = useState<Record<string, string>>({ retention_full: '2', uri_style: 'host', verify_tls: 'y' });
  const next = useMemo(() => {
    const used = new Set((status.repos ?? []).map((r) => r.index));
    let n = 2;
    while (used.has(n)) n++;
    return n;
  }, [status.repos]);
  useEffect(() => {
    if (open) setV({ retention_full: '2', uri_style: 'host', verify_tls: 'y' });
  }, [open]);
  const fields = FIELDS[type];
  const missing = fields.filter((f) => f.req && !(v[f.k] ?? '').trim());
  const badPath = (type === 'posix' || type === 'cifs' || type === 'sftp') && v.path && !v.path.startsWith('/');
  const repoHost = status.nodes.some((n) => n.status?.repo_host);
  const set = (k: string, val: string) => setV({ ...v, [k]: val });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t('rp_addTitle', { n: next })}</DialogTitle>
      <DialogContent>
        <Stack gap={2} pt={0.5}>
          <ToggleButtonGroup
            exclusive
            value={type}
            onChange={(_e, x) => x && setType(x)}
            size="small"
            sx={{ flexWrap: 'wrap', '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700, gap: 0.75 } }}>
            {TYPES.map((x) => (
              <ToggleButton key={x} value={x}>
                {repoIcon(x)}
                {t(`rp_tl_${x}`, { defaultValue: t(`rp_t_${x}`) })}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            {t(`rp_h_${type}`)}
            {type === 'posix' ? ` ${repoHost ? t('rp_h_posixRepoHost') : t('rp_h_posixShared')}` : ''}
          </Typography>
          <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            {fields.map((f) => (
              <TextField
                key={f.k}
                size="small"
                required={f.req}
                type={f.secret ? 'password' : 'text'}
                label={t(`rp_f_${type}_${f.k}`, { defaultValue: t(`rp_f_${f.k}`) })}
                placeholder={f.ph}
                value={v[f.k] ?? ''}
                onChange={(e) => set(f.k, e.target.value.trim())}
                error={f.k === 'path' && !!badPath}
                autoComplete="off"
              />
            ))}
            {type === 's3' ? (
              <TextField select size="small" label={t('rp_f_uri_style')} value={v.uri_style} onChange={(e) => set('uri_style', e.target.value)}>
                <MenuItem value="host">{t('rp_uriHost')}</MenuItem>
                <MenuItem value="path">{t('rp_uriPath')}</MenuItem>
              </TextField>
            ) : null}
            <TextField
              size="small"
              label={t('rp_f_retention_full')}
              value={v.retention_full ?? ''}
              onChange={(e) => set('retention_full', e.target.value.replace(/\D/g, ''))}
              helperText={t('rp_retentionHelp')}
            />
            <TextField
              size="small"
              type="password"
              label={t('rp_f_cipher_pass')}
              value={v.cipher_pass ?? ''}
              onChange={(e) => set('cipher_pass', e.target.value)}
              helperText={t('rp_cipherHelp')}
              autoComplete="new-password"
            />
          </Box>
          {type === 's3' || type === 'azure' || type === 'gcs' ? (
            <FormControlLabel
              control={<Checkbox checked={v.verify_tls !== 'n'} onChange={(e) => set('verify_tls', e.target.checked ? 'y' : 'n')} />}
              label={t('rp_verifyTls')}
            />
          ) : null}
          <Alert severity="info" sx={{ py: 0 }}>
            {t('rp_safe')}
          </Alert>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t('cancel', { ns: 'upgrade' })}</Button>
        <Button
          variant="contained"
          startIcon={<AddRounded />}
          disabled={missing.length > 0 || !!badPath}
          onClick={() => {
            const def: BRepoDef = { type };
            [...fields.map((f) => f.k), 'retention_full', 'cipher_pass'].forEach((k) => {
              if ((v[k] ?? '').trim()) def[k] = v[k].trim();
            });
            if (type === 's3') def.uri_style = v.uri_style;
            if (type === 's3' || type === 'azure' || type === 'gcs') def.verify_tls = v.verify_tls;
            void onAdd(next, def);
          }}>
          {t('rp_addGo')}
        </Button>
      </DialogActions>
    </Dialog>
  );
};

/** a repository picker: "pgBackRest's choice" or one repository (shown only when there are several) */
export const RepoPick: FC<{ status: BStatus; value: string; onChange: (v: string) => void; label: string; auto: string; width?: number }> = ({
  status,
  value,
  onChange,
  label,
  auto,
  width = 200,
}) => {
  const { t } = useTranslation('backup');
  const repos = status.repos ?? [];
  if (repos.length < 2) return null;
  return (
    <TextField select size="small" label={label} value={value} onChange={(e) => onChange(e.target.value)} sx={{ width }}>
      <MenuItem value="">{auto}</MenuItem>
      {repos.map((r) => (
        <MenuItem key={r.key} value={String(r.index)}>
          {repoName(r, t)}
        </MenuItem>
      ))}
    </TextField>
  );
};

/** "4 min", "3 h", "2 days" since a time */
const since = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
};

const anim = {
  '@keyframes rnFly': {
    '0%': { left: '0%', opacity: 0, transform: 'translateY(-50%) scale(.6)' },
    '12%': { opacity: 1 },
    '88%': { opacity: 1 },
    '100%': { left: '100%', opacity: 0, transform: 'translateY(-50%) scale(1)' },
  },
  '@keyframes rnBreath': { '0%,100%': { transform: 'scale(1)' }, '50%': { transform: 'scale(1.06)' } },
  '@keyframes rnRing': { '0%': { boxShadow: '0 0 0 0 rgba(46,160,67,.5)' }, '100%': { boxShadow: '0 0 0 10px rgba(46,160,67,0)' } },
  '@media (prefers-reduced-motion: reduce)': { '& *': { animation: 'none !important' } },
};

export type Running = {
  key: string;
  node: string;
  stanza: string;
  type: string;
  repo?: string;
  by: string;
  how?: string;
  user?: string;
  started: number; // epoch seconds
  size?: number;
  done?: number;
};

const clock = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = Math.floor(s % 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(x).padStart(2, '0')}`;
};

/** a backup running now that the console did not start (a schedule, or by hand): animated, with its progress */
export const RunningNow: FC<{ items: Running[]; status: BStatus | null }> = ({ items, status }) => {
  const { t } = useTranslation('backup');
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (!items.length) return null;
  return (
    <Stack gap={1.5} sx={anim}>
      {items.map((r) => {
        const pct = r.size && r.done !== undefined ? Math.min(100, (r.done / r.size) * 100) : undefined;
        const repo = (status?.repos ?? []).find((x) => String(x.index) === (r.repo || '1'));
        return (
          <Box
            key={r.key}
            data-testid="running-backup"
            sx={{
              p: { xs: 2, md: 2.5 },
              borderRadius: '18px',
              color: 'text.primary',
              position: 'relative',
              overflow: 'hidden',
              bgcolor: 'background.paper',
              border: 1,
              borderColor: 'divider',
              borderLeft: 4,
              borderLeftColor: 'primary.main',
            }}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2.5} alignItems={{ md: 'center' }}>
              <Box flex={1} minWidth={0}>
                <Stack direction="row" alignItems="center" gap={1}>
                  <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: 'success.main', animation: 'rnRing 1.6s infinite' }} />
                  <Typography sx={{ fontWeight: 700, letterSpacing: '.08em', fontSize: 12, color: 'success.main' }}>
                    {t('rn_live')}
                  </Typography>
                </Stack>
                <Typography sx={{ fontWeight: 700, fontSize: '1.15rem', mt: 0.5 }}>
                  {t('rn_title', { type: t(r.type) })}
                </Typography>
                <Stack direction="row" gap={0.75} mt={1} flexWrap="wrap">
                  <Chip
                    size="small"
                    icon={<ScheduleRounded />}
                    color="primary"
                    variant="outlined"
                    label={t(`rn_by_${r.by}`, { how: r.how ?? '' })}
                    sx={{ fontWeight: 600 }}
                  />
                  <Chip size="small" label={`${t('stanza')}: ${r.stanza || '—'}`} variant="outlined" />
                  <Chip size="small" label={r.node} variant="outlined" />
                  {r.user ? <Chip size="small" label={r.user} variant="outlined" /> : null}
                </Stack>
              </Box>
              {/* the picture: the database sends its data to the repository */}
              <Stack direction="row" alignItems="center" gap={1.5} sx={{ flex: 1.3, minWidth: 0 }}>
                <Stack alignItems="center" gap={0.5} sx={{ width: 84 }}>
                  <Box sx={{ animation: 'rnBreath 2.4s ease-in-out infinite' }}>
                    <svg width="46" height="54" viewBox="0 0 46 54">
                      <ellipse cx="23" cy="8" rx="20" ry="7" fill="#38B2F5" />
                      <path d="M3 8v36c0 4 9 7 20 7s20-3 20-7V8c0 4-9 7-20 7S3 12 3 8z" fill="#1D6FE0" />
                      <path d="M3 20c0 4 9 7 20 7s20-3 20-7M3 32c0 4 9 7 20 7s20-3 20-7" stroke="#0B1D3F" strokeWidth="1.6" fill="none" />
                    </svg>
                  </Box>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {t('primary')}
                  </Typography>
                </Stack>
                <Box sx={{ position: 'relative', flex: 1, height: 36 }}>
                  <Box sx={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 2, background: 'repeating-linear-gradient(90deg, rgba(120,140,170,.35) 0 8px, transparent 8px 14px)' }} />
                  {[0, 1, 2, 3, 4].map((i) => (
                    <Box
                      key={i}
                      sx={{
                        position: 'absolute',
                        top: '50%',
                        width: 14,
                        height: 10,
                        borderRadius: '3px',
                        bgcolor: 'primary.main',
                        opacity: 0.85,
                        animation: `rnFly 2.2s ${i * 0.44}s linear infinite`,
                      }}
                    />
                  ))}
                </Box>
                <Stack alignItems="center" gap={0.5} sx={{ width: 96 }}>
                  <Box
                    sx={{
                      width: 50,
                      height: 50,
                      borderRadius: '14px',
                      display: 'grid',
                      placeItems: 'center',
                      bgcolor: 'primary.lighter10',
                      color: 'primary.main',
                      animation: 'rnBreath 2.4s 1.2s ease-in-out infinite',
                      '& svg': { fontSize: 28 },
                    }}>
                    {repoIcon(repo?.type)}
                  </Box>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {repo ? repoName(repo, t) : t('flow.repository')}
                  </Typography>
                </Stack>
              </Stack>
              <Box sx={{ minWidth: 170 }}>
                <Typography sx={{ fontSize: 28, fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                  {pct !== undefined ? `${Math.floor(pct)}%` : clock(Math.max(0, now - r.started))}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {pct !== undefined
                    ? t('rn_progress', { done: bytes(r.done ?? 0), size: bytes(r.size ?? 0), time: clock(Math.max(0, now - r.started)) })
                    : r.size
                      ? t('rn_sizeOnly', { size: bytes(r.size) })
                      : t('rn_since', { time: new Date(r.started * 1000).toLocaleTimeString() })}
                </Typography>
              </Box>
            </Stack>
            <LinearProgress
              variant={pct !== undefined ? 'determinate' : 'indeterminate'}
              value={pct}
              sx={{
                mt: 2,
                height: 8,
                borderRadius: 4,
                '& .MuiLinearProgress-bar': { borderRadius: 4 },
              }}
            />
          </Box>
        );
      })}
    </Stack>
  );
};
