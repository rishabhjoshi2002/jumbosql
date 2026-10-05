import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Button,
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
import RouterPaths from '@app/router/routerPathsConfig';
import { generateAbsoluteRouterPath } from '@shared/lib/functions.ts';
import { Controller, useForm } from 'react-hook-form';
import { LoginFormValues } from '@pages/login/model/types.ts';
import { LOGIN_FORM_FIELD_NAMES } from '@pages/login/model/constants.ts';
import { usePostAuthLoginMutation } from '@shared/api/api/auth.ts';
import { setSession } from '@shared/lib/session.ts';
import { BRAND } from '@shared/theme/theme.ts';
import { version } from '../../../../package.json';
import logo from '@shared/assets/jumbosqlLogo.png';
import logoIcon from '@shared/assets/jumbosqlIcon.png';
import Watermark from '@shared/ui/watermark';

const highlights = ['loginHighlightInventory', 'loginHighlightPatroni', 'loginHighlightObservability'];

/**
 * JumboSQL sign-in: username and password, checked by the API (local users today; LDAP / SSO providers
 * plug in on the server side without changing this page).
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
      navigate(back && back !== '/login' ? back : generateAbsoluteRouterPath(RouterPaths.clusters.absolutePath));
    } catch (e) {
      const status = (e as { status?: number })?.status;
      setError(status === 401 ? t('invalidCredentials') : t('signInFailed'));
    }
  };

  return (
    <Stack direction="row" minHeight="100vh" sx={{ backgroundColor: 'background.default' }}>
      {isWide ? (
        <Stack
          data-surface="chrome"
          justifyContent="space-between"
          sx={{
            width: '46%',
            maxWidth: '640px',
            p: '48px 56px',
            color: BRAND.chromeText,
            background: `radial-gradient(1200px 600px at -10% 110%, rgba(56,178,245,0.28), transparent 60%),
              linear-gradient(160deg, ${BRAND.navy900} 0%, ${BRAND.navy800} 55%, ${BRAND.navy700} 100%)`,
          }}>
          <Stack direction="row" alignItems="center" gap="12px">
            <Box
              sx={{
                width: 44,
                height: 44,
                borderRadius: '12px',
                backgroundColor: '#fff',
                display: 'grid',
                placeItems: 'center',
              }}>
              <img src={logoIcon} alt="" style={{ width: 36, height: 36 }} data-logo="true" />
            </Box>
            <Typography sx={{ fontWeight: 800, fontSize: '1.25rem', letterSpacing: '-0.01em' }}>JumboSQL</Typography>
          </Stack>
          <Box>
            <Typography sx={{ color: BRAND.sky, fontWeight: 700, letterSpacing: '0.14em', fontSize: '0.78rem', mb: 2 }}>
              {t('productLine').toUpperCase()}
            </Typography>
            <Typography sx={{ fontWeight: 800, fontSize: '2.6rem', lineHeight: 1.1, letterSpacing: '-0.03em' }}>
              {t('loginHeadline')}
            </Typography>
            <Stack gap="14px" mt="32px">
              {highlights.map((key) => (
                <Stack key={key} direction="row" gap="12px" alignItems="flex-start">
                  <Box sx={{ width: 8, height: 8, mt: '8px', borderRadius: '50%', backgroundColor: BRAND.sky }} />
                  <Typography sx={{ color: BRAND.chromeMuted, fontSize: '1rem' }}>{t(key)}</Typography>
                </Stack>
              ))}
            </Stack>
          </Box>
          <Typography sx={{ color: BRAND.chromeMuted, fontSize: '0.78rem' }}>
            {t('basedOn')}{' '}
            <Link
              href="https://github.com/autobase-tech/autobase"
              target="_blank"
              underline="hover"
              sx={{ color: BRAND.sky }}>
              Autobase
            </Link>{' '}
            (MIT)
          </Typography>
        </Stack>
      ) : null}

      <Stack flex={1} alignItems="center" justifyContent="center" p="32px" position="relative">
        <Watermark variant="absolute" align="bottom" />
        <Box
          component="form"
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          sx={{ width: '100%', maxWidth: '380px', position: 'relative', zIndex: 1 }}>
          <Stack gap="20px">
            <Box textAlign="center">
              <img src={logo} alt="JumboSQL" style={{ width: 168, height: 168 }} data-logo="true" />
            </Box>
            <Box>
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
            <Button variant="contained" size="large" fullWidth type="submit" disabled={isLoading} sx={{ py: '12px' }}>
              {isLoading ? t('signingIn') : t('signIn')}
            </Button>
            <Typography variant="caption" color="text.secondary" textAlign="center">
              JumboSQL v{version} · {t('productLine')}
            </Typography>
          </Stack>
        </Box>
      </Stack>
    </Stack>
  );
};

export default Login;
