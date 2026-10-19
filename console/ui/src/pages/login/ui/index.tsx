import { FC, MouseEvent, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Link,
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
import { BRAND } from '@shared/theme/theme.ts';
import { version } from '../../../../package.json';
import { BrandLogo, BrandMark, BrandName } from '@shared/ui/brand';
import ClusterScene from './ClusterScene.tsx';

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
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const raf = useRef(0);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setTilt({ x, y }));
  };

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
      {/* the scene */}
      <Box
        data-surface="chrome"
        onMouseMove={isWide ? onMove : undefined}
        onMouseLeave={() => setTilt({ x: 0, y: 0 })}
        sx={{
          position: 'relative',
          flex: isWide ? '1 1 60%' : 'none',
          minHeight: isWide ? '100vh' : 'auto',
          color: BRAND.chromeText,
          background: `radial-gradient(1000px 520px at 50% 56%, #0F3557 0%, transparent 70%), ${BRAND.navy900}`,
          display: 'flex',
          flexDirection: 'column',
          px: { xs: 3, md: 6 },
          py: { xs: 3, md: 5 },
          overflow: 'hidden',
        }}>
        <Stack direction="row" alignItems="center" gap={1.25}>
          <BrandMark size={44} />
          <BrandName size="1.35rem" />
        </Stack>

        <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', py: { xs: 2, md: 3 }, perspective: '1400px' }}>
          <Box
            sx={{
              width: '100%',
              maxWidth: isWide ? 600 : 400,
              transform: `rotateX(${tilt.y * -6}deg) rotateY(${tilt.x * 8}deg)`,
              transition: 'transform .4s ease-out',
              transformStyle: 'preserve-3d',
            }}>
            <ClusterScene />
          </Box>
        </Box>

        {isWide ? (
          <Box sx={{ maxWidth: 660 }}>
            <Typography
              component="h1"
              sx={{ fontWeight: 700, fontSize: '2.25rem', lineHeight: 1.15, letterSpacing: '-0.025em', color: '#fff' }}>
              {t('loginHeadline')}
            </Typography>
            <Typography sx={{ color: BRAND.chromeMuted, mt: 1.5, fontSize: '1.05rem', lineHeight: 1.6 }}>
              {t('loginSub')}
            </Typography>
          </Box>
        ) : null}
      </Box>

      {/* the form */}
      <Stack
        flex={isWide ? '1 1 40%' : 1}
        alignItems="center"
        justifyContent="center"
        sx={{ px: { xs: 3, sm: 6 }, py: 6, position: 'relative', borderLeft: isWide ? 1 : 0, borderColor: 'divider' }}>
        <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate sx={{ width: '100%', maxWidth: 380 }}>
          <Stack gap="18px">
            <BrandLogo width={isWide ? 230 : 140} onDark={dark} sx={{ mb: 1 }} />
            <Box>
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
            <Typography variant="caption" color="text.secondary">
              {t('loginVersion', { version })}{' '}
              <Link href="https://github.com/autobase-tech/autobase" target="_blank" rel="noreferrer" underline="hover">
                Autobase
              </Link>{' '}
              (MIT)
            </Typography>
          </Stack>
        </Box>
        <Typography variant="caption" color="text.disabled" sx={{ position: 'absolute', bottom: 18 }}>
          Managed by Keen &amp; Able Computers Pvt. Ltd.
        </Typography>
      </Stack>
    </Stack>
  );
};

export default Login;
