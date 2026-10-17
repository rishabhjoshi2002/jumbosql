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
import logo from '@shared/assets/autonomicLogo.png';
import { BrandMark, BrandName } from '@shared/ui/brand';

const anim = {
  '@keyframes lgFloor': { from: { backgroundPosition: '0 0' }, to: { backgroundPosition: '0 64px' } },
  '@keyframes lgFloat': { '0%,100%': { transform: 'translateZ(60px) translateY(0)' }, '50%': { transform: 'translateZ(60px) translateY(-12px)' } },
  '@keyframes lgShadow': { '0%,100%': { transform: 'scale(1)', opacity: 0.55 }, '50%': { transform: 'scale(.86)', opacity: 0.35 } },
  '@keyframes lgOrbit': { from: { transform: 'rotateX(72deg) rotateZ(0deg)' }, to: { transform: 'rotateX(72deg) rotateZ(360deg)' } },
  '@media (prefers-reduced-motion: reduce)': { '& *': { animation: 'none !important' } },
};

/** the logo standing in a 3D space: it leans towards the mouse, floats over a moving floor, a ring turns around it */
const Stage: FC<{ size: number }> = ({ size }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ x: 0, y: 0 });
  const onMove = (e: MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTilt({ x: -py * 16, y: px * 20 });
  };
  return (
    <Box
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={() => setTilt({ x: 0, y: 0 })}
      sx={{ position: 'relative', width: size * 1.5, height: size * 1.3, perspective: '1100px', display: 'grid', placeItems: 'center' }}>
      <Box
        sx={{
          position: 'relative',
          width: size,
          height: size,
          transformStyle: 'preserve-3d',
          transform: `rotateX(${tilt.x}deg) rotateY(${tilt.y}deg)`,
          transition: 'transform .25s ease-out',
        }}>
        {/* a ring lying around the logo, turning */}
        <Box
          sx={{
            position: 'absolute',
            inset: '-14%',
            borderRadius: '50%',
            border: `2px solid ${BRAND.gold}`,
            opacity: 0.5,
            transformStyle: 'preserve-3d',
            animation: 'lgOrbit 14s linear infinite',
            '&::after': {
              content: '""',
              position: 'absolute',
              top: -6,
              left: '50%',
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: BRAND.gold,
              boxShadow: `0 0 14px ${BRAND.gold}`,
            },
          }}
        />
        <Box
          component="img"
          src={logo}
          alt={BRAND.name}
          data-logo="true"
          sx={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            animation: 'lgFloat 6s ease-in-out infinite',
            filter: 'drop-shadow(0 24px 30px rgba(0,0,0,.45))',
          }}
        />
      </Box>
      {/* its shadow on the floor */}
      <Box
        sx={{
          position: 'absolute',
          bottom: '2%',
          width: size * 0.7,
          height: size * 0.09,
          borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(0,0,0,.6), transparent)',
          animation: 'lgShadow 6s ease-in-out infinite',
        }}
      />
    </Box>
  );
};

/**
 * autoNOMIC sign-in: username and password, checked by the API (local users today; LDAP / SSO providers plug in
 * on the server side without changing this page). Left: the logo in a small 3D scene. Right: a plain sign-in form.
 */
const Login: FC = () => {
  const { t } = useTranslation('shared');
  const navigate = useNavigate();
  const location = useLocation();
  const isWide = useMediaQuery('(min-width: 960px)');
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
    <Stack direction={isWide ? 'row' : 'column'} minHeight="100vh" sx={{ ...anim, bgcolor: 'background.default' }}>
      {/* the scene */}
      <Box
        data-surface="chrome"
        sx={{
          position: 'relative',
          overflow: 'hidden',
          flex: isWide ? '1 1 58%' : 'none',
          minHeight: isWide ? '100vh' : 300,
          color: BRAND.chromeText,
          background: `radial-gradient(800px 420px at 50% 38%, rgba(56,178,245,.22), transparent 70%),
            linear-gradient(180deg, ${BRAND.navy900} 0%, ${BRAND.navy800} 60%, ${BRAND.navy700} 100%)`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
        {/* the floor: a grid running towards you */}
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            left: '-60%',
            right: '-60%',
            bottom: 0,
            height: '150%',
            transform: 'perspective(600px) rotateX(68deg)',
            transformOrigin: 'center bottom',
            backgroundImage: `linear-gradient(rgba(56,178,245,.38) 2px, transparent 2px),
              linear-gradient(90deg, rgba(56,178,245,.38) 2px, transparent 2px)`,
            backgroundSize: '64px 64px',
            animation: 'lgFloor 2.4s linear infinite',
            maskImage: 'linear-gradient(to top, black 25%, transparent 88%)',
          }}
        />
        <Box sx={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Stage size={isWide ? 300 : 170} />
          {isWide ? (
            <Box textAlign="center" mt={1} px={3}>
              <Typography sx={{ fontWeight: 800, fontSize: '2.1rem', letterSpacing: '-0.02em', color: '#fff' }}>
                {t('loginHeadline')}
              </Typography>
              <Typography sx={{ color: BRAND.chromeMuted, mt: 1, fontSize: '1rem' }}>{t('loginSub')}</Typography>
            </Box>
          ) : null}
        </Box>
      </Box>

      {/* the form */}
      <Stack flex={isWide ? '1 1 42%' : 1} alignItems="center" justifyContent="center" sx={{ p: { xs: 3, sm: 5 }, position: 'relative' }}>
        <Box component="form" onSubmit={handleSubmit(onSubmit)} noValidate sx={{ width: '100%', maxWidth: 380 }}>
          <Stack gap="18px">
            <Stack direction="row" alignItems="center" gap={1.25}>
              <BrandMark size={40} />
              <BrandName size="1.45rem" light={false} />
            </Stack>
            <Box mt={1}>
              <Typography variant="h5">{t('signIn')}</Typography>
              <Typography color="text.secondary" mt="4px">
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
              sx={{ py: '12px' }}>
              {isLoading ? t('signingIn') : t('signIn')}
            </Button>
            <Typography variant="caption" color="text.secondary" textAlign="center">
              v{version} · {t('basedOn')}{' '}
              <Link href="https://github.com/autobase-tech/autobase" target="_blank" rel="noreferrer" underline="hover">
                Autobase
              </Link>{' '}
              (MIT)
            </Typography>
          </Stack>
        </Box>
        <Typography variant="caption" color="text.disabled" sx={{ position: 'absolute', bottom: 16 }}>
          Managed by Keen &amp; Able Computers Pvt. Ltd.
        </Typography>
      </Stack>
    </Stack>
  );
};

export default Login;
