import { FC, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import KeyIcon from '@mui/icons-material/VpnKeyOutlined';
import { useTranslation } from 'react-i18next';
import { DSSHNeed, HostAuth } from '@shared/api/api/discover.ts';

type Row = { user: string; password: string; key: string; port: string };

/** Machines SSH could not enter: a warning, and a pop-up to give a login for each (used once, never saved). */
const SshNeeded: FC<{
  needed: DSSHNeed[];
  defaultUser: string;
  autoOpen: boolean;
  running: boolean;
  onSubmit: (auth: HostAuth[]) => void;
}> = ({ needed, defaultUser, autoOpen, running, onSubmit }) => {
  const { t } = useTranslation('discover');
  const [open, setOpen] = useState(false);
  const [same, setSame] = useState(true);
  const [rows, setRows] = useState<Record<string, Row>>({});

  useEffect(() => {
    setRows(
      Object.fromEntries(needed.map((n) => [n.address, { user: defaultUser, password: '', key: '', port: '22' }])),
    );
    if (autoOpen && needed.length) setOpen(true);
  }, [needed, defaultUser, autoOpen]);

  if (!needed.length) return null;
  const first = rows[needed[0].address] ?? { user: '', password: '', key: '', port: '22' };
  const set = (addr: string, k: keyof Row, v: string) =>
    setRows((r) => {
      if (same) return Object.fromEntries(Object.keys(r).map((a) => [a, { ...r[a], [k]: v }]));
      return { ...r, [addr]: { ...r[addr], [k]: v } };
    });
  const submit = () => {
    const auth = needed
      .map((n) => ({ n, r: rows[n.address] }))
      .filter(({ r }) => r && r.user.trim() && (r.password || r.key.trim()))
      .map(({ n, r }) => ({
        host: n.address,
        user: r.user.trim(),
        port: Number(r.port) || 22,
        password: r.password || undefined,
        key: r.key.trim() || undefined,
      }));
    // "same for all" also covers machines found in the next run
    const r0 = rows[needed[0].address];
    if (same && r0?.user.trim() && (r0.password || r0.key.trim())) {
      auth.push({
        host: '*',
        user: r0.user.trim(),
        port: Number(r0.port) || 22,
        password: r0.password || undefined,
        key: r0.key.trim() || undefined,
      });
    }
    setOpen(false);
    onSubmit(auth);
  };
  const field = (addr: string, k: keyof Row, label: string, type = 'text') => (
    <TextField
      size="small"
      label={label}
      type={type}
      value={rows[addr]?.[k] ?? ''}
      onChange={(e) => set(addr, k, e.target.value)}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      fullWidth
    />
  );

  return (
    <>
      <Alert
        severity="warning"
        action={
          <Button color="inherit" size="small" startIcon={<KeyIcon />} onClick={() => setOpen(true)}>
            {t('sshGive')}
          </Button>
        }>
        {t('sshNeededLine', { count: needed.length, hosts: needed.map((n) => n.name || n.address).join(', ') })}
      </Alert>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle>{t('sshDialogTitle')}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={1.5}>
            {t('sshDialogHelp')}
          </Typography>
          <Table size="small" sx={{ mb: 2 }}>
            <TableHead>
              <TableRow>
                <TableCell>{t('c_machine')}</TableCell>
                <TableCell>{t('c_runs')}</TableCell>
                <TableCell>{t('sshWhy')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {needed.map((n) => (
                <TableRow key={n.address}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <b>{n.name || n.address}</b>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {n.address}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    {(n.roles ?? []).map((r) => t(`lane_${r === 'ha' ? 'database' : r}`)).join(', ')}
                  </TableCell>
                  <TableCell>
                    <Typography variant="caption">{n.reason}</Typography>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <FormControlLabel
            control={<Checkbox checked={same} onChange={(e) => setSame(e.target.checked)} />}
            label={<Typography variant="body2">{t('sshSameForAll')}</Typography>}
          />
          <Stack gap={2} mt={1}>
            {(same ? needed.slice(0, 1) : needed).map((n) => (
              <Stack key={n.address} gap={1}>
                {!same ? (
                  <Typography variant="body2" fontWeight={700}>
                    {n.name || n.address}
                  </Typography>
                ) : null}
                <Stack direction="row" gap={1}>
                  {field(n.address, 'user', t('sshUser'))}
                  {field(n.address, 'password', t('sshPassword'), 'password')}
                  <TextField
                    size="small"
                    label={t('sshPort')}
                    value={rows[n.address]?.port ?? '22'}
                    onChange={(e) => set(n.address, 'port', e.target.value.replace(/\D/g, ''))}
                    sx={{ width: 110, flexShrink: 0 }}
                  />
                </Stack>
                <TextField
                  size="small"
                  label={t('sshKey')}
                  multiline
                  minRows={2}
                  maxRows={5}
                  value={rows[n.address]?.key ?? ''}
                  onChange={(e) => set(n.address, 'key', e.target.value)}
                  InputProps={{ sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 12 } }}
                />
              </Stack>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>{t('later')}</Button>
          <Button variant="contained" disabled={running || !first.user.trim()} onClick={submit} startIcon={<KeyIcon />}>
            {t('sshRetry')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default SshNeeded;
