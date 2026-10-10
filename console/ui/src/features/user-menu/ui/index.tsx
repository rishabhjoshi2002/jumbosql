import { FC, useState } from 'react';
import {
  Avatar,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import KeyOutlined from '@mui/icons-material/KeyOutlined';
import LogoutOutlined from '@mui/icons-material/LogoutOutlined';
import GroupOutlined from '@mui/icons-material/GroupOutlined';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import RouterPaths from '@app/router/routerPathsConfig';
import { generateAbsoluteRouterPath, handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { can, clearSession, userGroup } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import { usePostAuthLogoutMutation, usePostAuthPasswordMutation } from '@shared/api/api/auth.ts';
import { BRAND } from '@shared/theme/theme.ts';

const initials = (name: string) =>
  name
    .split(/[\s._@-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

/** pg_genie: signed-in user, change password, user management (admins) and sign out. */
const UserMenu: FC = () => {
  const { t } = useTranslation('shared');
  const navigate = useNavigate();
  const user = useSessionUser();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [logout] = usePostAuthLogoutMutation();
  const [changePassword, changeState] = usePostAuthPasswordMutation();

  const name = user?.display_name || user?.username || 'api-token';

  const signOut = async () => {
    setAnchor(null);
    try {
      await logout().unwrap();
    } catch {
      // the session is cleared locally either way
    }
    clearSession();
    navigate(generateAbsoluteRouterPath(RouterPaths.login.absolutePath));
  };

  const submitPassword = async () => {
    try {
      await changePassword({ current_password: current, new_password: next }).unwrap();
      toast.success(t('passwordChanged'));
      setPwOpen(false);
      clearSession();
      navigate(generateAbsoluteRouterPath(RouterPaths.login.absolutePath));
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  return (
    <>
      <Button
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{
          color: BRAND.chromeText,
          gap: '10px',
          px: '8px',
          '&:hover': { backgroundColor: 'rgba(255,255,255,0.08)' },
        }}>
        <Avatar sx={{ width: 32, height: 32, fontSize: '0.8rem', fontWeight: 700, bgcolor: BRAND.blue }}>
          {initials(name)}
        </Avatar>
        <Box textAlign="left" sx={{ lineHeight: 1.1, display: { xs: 'none', md: 'block' } }}>
          <Typography sx={{ fontSize: '0.86rem', fontWeight: 700, color: BRAND.chromeText }}>{name}</Typography>
          <Typography sx={{ fontSize: '0.72rem', color: BRAND.chromeMuted, textTransform: 'capitalize' }}>
            {userGroup(user) || user?.username}
          </Typography>
        </Box>
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <Box px="14px" py="8px" minWidth="220px">
          <Typography fontWeight={700}>{name}</Typography>
          <Stack direction="row" gap="6px" alignItems="center" mt="4px">
            <Typography variant="caption" color="text.secondary">
              {user?.username}
            </Typography>
            {userGroup(user) ? (
              <Chip size="small" label={userGroup(user)} sx={{ height: 20, textTransform: 'capitalize' }} />
            ) : null}
          </Stack>
        </Box>
        <Divider />
        {user?.auth_provider === 'local' || !user?.auth_provider ? (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              setCurrent('');
              setNext('');
              setPwOpen(true);
            }}>
            <ListItemIcon>
              <KeyOutlined fontSize="small" />
            </ListItemIcon>
            {t('changePassword')}
          </MenuItem>
        ) : null}
        {can('users.manage', undefined, user) ? (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              navigate(generateAbsoluteRouterPath(RouterPaths.settings.users.absolutePath));
            }}>
            <ListItemIcon>
              <GroupOutlined fontSize="small" />
            </ListItemIcon>
            {t('manageUsers')}
          </MenuItem>
        ) : null}
        <MenuItem onClick={signOut}>
          <ListItemIcon>
            <LogoutOutlined fontSize="small" />
          </ListItemIcon>
          {t('signOut')}
        </MenuItem>
      </Menu>

      <Dialog open={pwOpen} onClose={() => setPwOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>{t('changePassword')}</DialogTitle>
        <DialogContent>
          <Stack gap="16px" mt="8px">
            <TextField
              type="password"
              label={t('currentPassword')}
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              autoComplete="current-password"
            />
            <TextField
              type="password"
              label={t('newPassword')}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              helperText={t('passwordRule')}
              error={!!next && next.length < 8}
              autoComplete="new-password"
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: '24px', pb: '16px' }}>
          <Button onClick={() => setPwOpen(false)}>{t('cancel')}</Button>
          <Button
            variant="contained"
            disabled={!current || next.length < 8 || changeState.isLoading}
            onClick={submitPassword}>
            {t('changePassword')}
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
};

export default UserMenu;
