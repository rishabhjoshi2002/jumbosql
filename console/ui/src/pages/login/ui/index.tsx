import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import VisibilityOutlined from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlined from '@mui/icons-material/VisibilityOffOutlined';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { LoginFormValues } from '@pages/login/model/types.ts';
import { LOGIN_FORM_FIELD_NAMES } from '@pages/login/model/constants.ts';
import { usePostAuthLoginMutation } from '@shared/api/api/auth.ts';
import { setSession } from '@shared/lib/session.ts';
import { version } from '../../../../package.json';
import { BrandLogo, BrandMark, BrandName } from '@shared/ui/brand';
import Scene3D from './Scene3D.tsx';

/**
 * KeenPG sign-in: username and password, checked by the API (local users today; LDAP / SSO providers plug in
 * on the server side without changing this page).
 * Left: what the product looks after, drawn in isometric 3D - a primary streaming WAL to its replicas and its
 * backup repository. The scene leans a little with the mouse; nothing else moves. Right: a plain sign-in form.
 */
const Login: FC = () => {
  const { t } = useTranslation('shared');
  const navigate = useNavigate();
  const location = useLocation();
  const isWide = useMediaQuery('(min-width: 1000px)');
  const dark = useTheme().palette.mode === 'dark';
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');

  const { handleSubmit, control } = useForm<LoginFormValues>({
    defaultValues: { [LOGIN_FORM_FIELD_NAMES.USERNAME]: '', [LOGIN_FORM_FIELD_NAMES.PASSWORD]: '' },
  });
  const [login, { isLoading }] = usePostAuthLoginMutation();

  const onSubmit = async (values: LoginFormValues) => {
    setError('');
    try {
      const res = await login({
        username: values[LOGIN_FORM_FIELD_NAMES.USERNAME].trim(),
        password: values[LOGIN_FORM_FIELD_NAMES.PASSWORD],
      }).unwrap();
      setSession(res.token, res.user);
      const back = (location.state as { path?: string } | null)?.path;
      // "/" opens the user's own start page
      navigate(back && back !== '/login' ? back : '/');
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(status === 401 ? t('invalidCredentials') : t('signInFailed'));
    }
  };

  return (
    <Stack direction={isWide ? 'row' : 'column'} minHeight="100vh" sx={{ bgcolor: 'background.paper' }}>
      {/* the scene: what KeenPG does, in 3D, on a light background; brand on top, headline at the bottom */}
      <Box
        sx={{
          position: 'relative',
          flex: isWide ? '1 1 62%' : 'none',
          minHeight: isWide ? '100vh' : 380,
          overflow: 'hidden',
          background: dark
            ? 'radial-gradient(900px 600px at 50% 45%, #2A2350 0%, transparent 70%), linear-gradient(150deg, #17132E 0%, #241B33 100%)'
            : 'radial-gradient(900px 600px at 50% 45%, #FFFFFF 0%, transparent 70%), linear-gradient(150deg, #F1EEFC 0%, #F7F1F8 55%, #FDF1E2 100%)',
          // a fine honeycomb, like the facets of the logo
          '&::before': {
            content: '""',
            position: 'absolute',
            inset: 0,
            backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='56' height='97' viewBox='0 0 56 97'><path d='M28 0 56 16v32L28 64 0 48V16zM28 97V64' fill='none' stroke='%234B3AC4' stroke-opacity='.09' stroke-width='1'/></svg>")`,
            backgroundSize: '56px 97px',
            opacity: dark ? 0.6 : 1,
            maskImage: 'radial-gradient(circle at 50% 45%, transparent 18%, black 75%)',
          },
        }}>
        <Scene3D />
        <Stack
          sx={{ position: 'relative', height: '100%', minHeight: 'inherit', pointerEvents: 'none' }}
          justifyContent="space-between"
          px={{ xs: 3, md: 6 }}
          py={{ xs: 3, md: 5 }}>
          <Stack direction="row" alignItems="center" gap={1.25}>
            <BrandMark size={44} />
            <BrandName size="1.35rem" light={dark} />
          </Stack>
          {isWide ? (
            <Box sx={{ maxWidth: 640 }}>
              <Typography
                component="h1"
                sx={{
                  fontWeight: 800,
                  fontSize: '2.4rem',
                  lineHeight: 1.12,
                  letterSpacing: '-0.025em',
                  color: 'text.primary',
                }}>
                {t('loginHeadline')}
              </Typography>
              <Typography color="text.secondary" sx={{ mt: 1.25, fontSize: '1.05rem', lineHeight: 1.6 }}>
                {t('loginSub')}
              </Typography>
            </Box>
          ) : null}
        </Stack>
      </Box>

      {/* the form */}
      <Stack
        flex={isWide ? '1 1 40%' : 1}
        alignItems="center"
        justifyContent="center"
        sx={{ px: { xs: 3, sm: 6 }, py: 6, position: 'relative', borderLeft: isWide ? 1 : 0, borderColor: 'divider' }}>
        <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate sx={{ width: '100%', maxWidth: 380 }}>
          <Stack gap="18px">
            <BrandLogo width={isWide ? 200 : 140} onDark={dark} sx={{ mb: 1, mx: 'auto' }} />
            <Box textAlign="center">
              <Typography sx={{ fontWeight: 700, fontSize: '1.75rem', letterSpacing: '-0.02em' }}>
                {t('signIn')}
              </Typography>
              <Typography color="text.secondary" mt="6px">
                {t('signInSubtitle')}
              </Typography>
            </Box>
            {error ? <Alert severity="error">{error}</Alert> : null}
            <Controller
              control={control}
              name={LOGIN_FORM_FIELD_NAMES.USERNAME}
              render={({ field }) => (
                <TextField {...field} required autoFocus fullWidth label={t('username')} autoComplete="username" />
              )}
            />
            <Controller
              control={control}
              name={LOGIN_FORM_FIELD_NAMES.PASSWORD}
              render={({ field }) => (
                <TextField
                  {...field}
                  required
                  fullWidth
                  type={showPassword ? 'text' : 'password'}
                  label={t('password')}
                  autoComplete="current-password"
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label={showPassword ? t('hidePassword') : t('showPassword')}
                            onClick={() => setShowPassword((v) => !v)}
                            edge="end"
                            size="small">
                            {showPassword ? <VisibilityOffOutlined /> : <VisibilityOutlined />}
                          </IconButton>
                        </InputAdornment>
                      ),
                    },
                  }}
                />
              )}
            />
            <Button
              variant="contained"
              size="large"
              fullWidth
              type="submit"
              disabled={isLoading}
              startIcon={isLoading ? <CircularProgress size={18} color="inherit" /> : null}
              sx={{ py: '12px', fontSize: '1rem' }}>
              {isLoading ? t('signingIn') : t('signIn')}
            </Button>
            <Typography variant="caption" color="text.secondary" textAlign="center">
              Version {version}
            </Typography>
          </Stack>
        </Box>
        <Typography
          variant="body2"
          sx={{ position: 'absolute', bottom: 18, color: 'text.secondary', fontWeight: 500 }}>
          Managed by Keen &amp; Able Computers Pvt. Ltd.
        </Typography>
      </Stack>
    </Stack>
  );
};

export default Login;
