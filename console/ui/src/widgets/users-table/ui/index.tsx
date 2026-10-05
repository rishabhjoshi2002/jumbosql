import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonAddAlt1Outlined from '@mui/icons-material/PersonAddAlt1Outlined';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import {
  ApiUser,
  useDeleteUsersByIdMutation,
  useGetUsersQuery,
  usePatchUsersByIdMutation,
  usePostUsersMutation,
} from '@shared/api/api/auth.ts';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { getSessionUser } from '@shared/lib/session.ts';

const ROLES = ['admin', 'operator', 'viewer'] as const;

const formatDate = (v?: string | null) => (v ? new Date(v).toLocaleString() : '—');

/**
 * JumboSQL: Settings > Users (admins only). Local users today; users from LDAP / SSO will show up here with
 * their provider and can't have their password changed from the console.
 */
const UsersTable: FC = () => {
  const { t } = useTranslation(['settings', 'shared']);
  const me = getSessionUser();
  const users = useGetUsersQuery();
  const [addUser, addState] = usePostUsersMutation();
  const [patchUser] = usePatchUsersByIdMutation();
  const [deleteUser] = useDeleteUsersByIdMutation();

  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ username: '', display_name: '', password: '', role: 'operator' });
  const [pwUser, setPwUser] = useState<ApiUser | null>(null);
  const [newPw, setNewPw] = useState('');

  const submitAdd = async () => {
    try {
      await addUser(form).unwrap();
      toast.success(t('userAdded', { username: form.username }));
      setAddOpen(false);
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const changeRole = async (u: ApiUser, role: string) => {
    try {
      await patchUser({ id: u.id, role }).unwrap();
      toast.success(t('roleChanged', { username: u.username, role }));
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const submitPassword = async () => {
    if (!pwUser) return;
    try {
      await patchUser({ id: pwUser.id, password: newPw }).unwrap();
      toast.success(t('passwordReset', { username: pwUser.username }));
      setPwUser(null);
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const remove = async (u: ApiUser) => {
    if (!window.confirm(t('confirmRemoveUser', { username: u.username }))) return;
    try {
      await deleteUser({ id: u.id }).unwrap();
      toast.success(t('userRemoved', { username: u.username }));
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  return (
    <Stack gap="16px" p="16px">
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" gap="16px">
        <Box>
          <Typography variant="h6">{t('users')}</Typography>
          <Typography variant="body2" color="text.secondary" maxWidth="720px">
            {t('usersHelp')}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<PersonAddAlt1Outlined />}
          onClick={() => {
            setForm({ username: '', display_name: '', password: '', role: 'operator' });
            setAddOpen(true);
          }}>
          {t('addUser')}
        </Button>
      </Stack>

      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>{t('username', { ns: 'shared' })}</TableCell>
              <TableCell>{t('displayName')}</TableCell>
              <TableCell>{t('role')}</TableCell>
              <TableCell>{t('signInWith')}</TableCell>
              <TableCell>{t('lastSignIn')}</TableCell>
              <TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {(users.data ?? []).map((u) => {
              const isMe = u.id === me?.id;
              return (
                <TableRow key={u.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>
                    {u.username} {isMe ? <Chip size="small" label={t('you')} sx={{ ml: 1, height: 20 }} /> : null}
                  </TableCell>
                  <TableCell>{u.display_name || '—'}</TableCell>
                  <TableCell sx={{ minWidth: 150 }}>
                    <TextField
                      select
                      size="small"
                      value={u.role}
                      disabled={isMe}
                      onChange={(e) => changeRole(u, e.target.value)}
                      sx={{ minWidth: 130 }}>
                      {ROLES.map((r) => (
                        <MenuItem key={r} value={r} sx={{ textTransform: 'capitalize' }}>
                          {t(`role_${r}`)}
                        </MenuItem>
                      ))}
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <Chip size="small" label={u.auth_provider === 'local' ? t('localPassword') : u.auth_provider} />
                  </TableCell>
                  <TableCell>{formatDate(u.last_login_at)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {u.auth_provider === 'local' ? (
                      <Tooltip title={t('resetPassword')}>
                        <IconButton
                          size="small"
                          onClick={() => {
                            setNewPw('');
                            setPwUser(u);
                          }}>
                          <KeyOutlined fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                    <Tooltip title={isMe ? t('cantRemoveYourself') : t('removeUser')}>
                      <span>
                        <IconButton size="small" disabled={isMe} onClick={() => remove(u)}>
                          <DeleteOutline fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      <Alert severity="info">{t('rolesHelp')}</Alert>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('addUser')}</DialogTitle>
        <DialogContent>
          <Stack gap="16px" mt="8px">
            <TextField
              label={t('username', { ns: 'shared' })}
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
              required
            />
            <TextField
              label={t('displayName')}
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
            <TextField
              type="password"
              label={t('password', { ns: 'shared' })}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              helperText={t('passwordRule', { ns: 'shared' })}
              error={!!form.password && form.password.length < 8}
              autoComplete="new-password"
              required
            />
            <TextField
              select
              label={t('role')}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => (
                <MenuItem key={r} value={r}>
                  {t(`role_${r}`)}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: '24px', pb: '16px' }}>
          <Button onClick={() => setAddOpen(false)}>{t('cancel', { ns: 'shared' })}</Button>
          <Button
            variant="contained"
            disabled={!form.username || form.password.length < 8 || addState.isLoading}
            onClick={submitAdd}>
            {t('addUser')}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!pwUser} onClose={() => setPwUser(null)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('resetPasswordFor', { username: pwUser?.username })}</DialogTitle>
        <DialogContent>
          <TextField
            sx={{ mt: '8px' }}
            fullWidth
            type="password"
            label={t('newPassword', { ns: 'shared' })}
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            helperText={t('resetPasswordHelp')}
            error={!!newPw && newPw.length < 8}
            autoComplete="new-password"
          />
        </DialogContent>
        <DialogActions sx={{ px: '24px', pb: '16px' }}>
          <Button onClick={() => setPwUser(null)}>{t('cancel', { ns: 'shared' })}</Button>
          <Button variant="contained" disabled={newPw.length < 8} onClick={submitPassword}>
            {t('resetPassword')}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
};

export default UsersTable;
