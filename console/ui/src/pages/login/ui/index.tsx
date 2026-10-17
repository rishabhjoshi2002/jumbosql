import { FC, MouseEvent, useEffect, useRef, useState } from 'react';
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
import PersonOutline from '@mui/icons-material/PersonOutline';
import LockOutlined from '@mui/icons-material/LockOutlined';
import ArrowForward from '@mui/icons-material/ArrowForward';
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
import AnimatedNetwork from '@shared/ui/animated-network';

const WORDS = ['Contained', 'Native', 'Intelligent', 'Maintained', 'Orchestrated'];
// what the atmos CLI does, typed out one after the other
const COMMANDS = [
  { cmd: 'atmos discover 10.0.0.0/24', out: '3 clusters · 9 nodes found' },
  { cmd: 'atmos backup prod --type full', out: 'backup 20261017-010000F · 4.2 GB · done' },
  { cmd: 'atmos restore prod --time "10:30"', out: 'restored · replicas streaming' },
  { cmd: 'atmos upgrade patroni --dry-run', out: '3 nodes · rollback plan ready' },
];

const anim = {
  '@keyframes lgSpin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
  '@keyframes lgSpinBack': { from: { transform: 'rotate(360deg)' }, to: { transform: 'rotate(0deg)' } },
  '@keyframes lgFloat': { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-10px)' } },
  '@keyframes lgGlow': {
    '0%,100%': { opacity: 0.55, transform: 'scale(1)' },
    '50%': { opacity: 0.95, transform: 'scale(1.06)' },
  },
  '@keyframes lgRise': {
    from: { opacity: 0, transform: 'translateY(18px)' },
    to: { opacity: 1, transform: 'translateY(0)' },
  },
  '@keyframes lgBlink': { '0%,49%': { opacity: 1 }, '50%,100%': { opacity: 0 } },
  '@keyframes lgShine': { from: { backgroundPosition: '-200% 0' }, to: { backgroundPosition: '200% 0' } },
  '@keyframes lgFloor': { from: { backgroundPosition: '0 0' }, to: { backgroundPosition: '0 72px' } },
  '@keyframes lgOrbitA': {
    from: { transform: 'rotateX(74deg) rotateZ(0deg)' },
    to: { transform: 'rotateX(74deg) rotateZ(360deg)' },
  },
  '@keyframes lgOrbitB': {
    from: { transform: 'rotateX(74deg) rotateY(14deg) rotateZ(360deg)' },
    to: { transform: 'rotateX(74deg) rotateY(14deg) rotateZ(0deg)' },
  },
  '@keyframes lgHover': {
    '0%,100%': { transform: 'translateZ(70px) translateY(0)' },
    '50%': { transform: 'translateZ(70px) translateY(-14px)' },
  },
  '@keyframes lgShadow': {
    '0%,100%': { transform: 'translateX(-50%) scale(1, .3)', opacity: 0.75 },
    '50%': { transform: 'translateX(-50%) scale(.78, .24)', opacity: 0.45 },
  },
  '@keyframes lgBob': { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-16px)' } },
  '@media (prefers-reduced-motion: reduce)': { '& *': { animation: 'none !important' } },
};

/** the atmos terminal: types each command, shows its answer, moves on */
const Terminal: FC = () => {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    const c = COMMANDS[i];
    const id = window.setTimeout(
      () => {
        if (n < c.cmd.length) setN(n + 1);
        else if (!done) setDone(true);
        else {
          setDone(false);
          setN(0);
          setI((i + 1) % COMMANDS.length);
        }
      },
      n < c.cmd.length ? 45 + Math.random() * 50 : done ? 2200 : 450,
    );
    return () => window.clearTimeout(id);
  }, [i, n, done]);
  const c = COMMANDS[i];
  return (
    <Box
      sx={{
        width: '100%',
        maxWidth: 440,
        borderRadius: '14px',
        overflow: 'hidden',
        border: '1px solid rgba(120,170,255,0.22)',
        background: 'rgba(5,12,36,0.72)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 18px 50px rgba(0,0,0,0.35)',
        fontFamily: BRAND.fontMono,
        fontSize: 13,
      }}>
      <Stack
        direction="row"
        alignItems="center"
        gap="7px"
        sx={{ px: 1.5, py: 1, background: 'rgba(255,255,255,0.04)' }}>
        {['#FF5F57', '#FEBC2E', '#28C840'].map((col) => (
          <Box key={col} sx={{ width: 10, height: 10, borderRadius: '50%', background: col, opacity: 0.85 }} />
        ))}
        <Typography sx={{ ml: 1, fontFamily: BRAND.fontMono, fontSize: 12, color: BRAND.chromeMuted }}>
          {BRAND.cli} — autoNOMIC CLI
        </Typography>
      </Stack>
      <Box sx={{ px: 2, py: 1.5, minHeight: 66, color: BRAND.chromeText }}>
        <Box>
          <Box component="span" sx={{ color: BRAND.gold }}>
            ${' '}
          </Box>
          {c.cmd.slice(0, n)}
          <Box
            component="span"
            sx={{
              display: 'inline-block',
              width: 8,
              height: 15,
              ml: '2px',
              verticalAlign: '-2px',
              background: BRAND.gold,
              animation: 'lgBlink 1s step-end infinite',
            }}
          />
        </Box>
        <Box sx={{ color: '#5BE49B', mt: 0.5, opacity: done ? 1 : 0, transition: 'opacity .25s' }}>✓ {c.out}</Box>
      </Box>
    </Box>
  );
};

type Tilt = { x: number; y: number }; // the mouse, -0.5 .. 0.5 from the centre of the page

/** a database drawn as a cylinder, for the floating pieces around the scene */
const Cylinder: FC<{ size: number; tone: string }> = ({ size, tone }) => (
  <svg width={size} height={size * 1.18} viewBox="0 0 50 59" aria-hidden>
    <defs>
      <linearGradient id={`cy${tone.slice(1)}`} x1="0" x2="1">
        <stop offset="0" stopColor={tone} stopOpacity="0.95" />
        <stop offset="0.55" stopColor={tone} stopOpacity="0.6" />
        <stop offset="1" stopColor={tone} stopOpacity="0.9" />
      </linearGradient>
    </defs>
    <path d="M3 9v40c0 4.4 9.8 8 22 8s22-3.6 22-8V9" fill={`url(#cy${tone.slice(1)})`} />
    <path
      d="M3 22c0 4.4 9.8 8 22 8s22-3.6 22-8M3 35c0 4.4 9.8 8 22 8s22-3.6 22-8"
      fill="none"
      stroke="rgba(7,20,48,.55)"
      strokeWidth="1.6"
    />
    <ellipse cx="25" cy="9" rx="22" ry="8" fill={tone} />
  </svg>
);

/** databases floating at different depths; nearer ones move more with the mouse and are sharper */
const Floaters: FC<{ m: Tilt }> = ({ m }) => (
  <>
    {[
      { left: '7%', top: '16%', size: 54, depth: 1, tone: '#38B2F5', delay: 0 },
      { left: '86%', top: '12%', size: 38, depth: 0.5, tone: '#F4B321', delay: 1.2 },
      { left: '91%', top: '78%', size: 60, depth: 1.3, tone: '#1D6FE0', delay: 0.6 },
      { left: '14%', top: '74%', size: 34, depth: 0.4, tone: '#F4B321', delay: 2 },
      { left: '48%', top: '6%', size: 26, depth: 0.3, tone: '#38B2F5', delay: 1.6 },
    ].map((f, i) => (
      <Box
        key={i}
        aria-hidden
        sx={{
          position: 'absolute',
          left: f.left,
          top: f.top,
          transform: `translate3d(${m.x * -60 * f.depth}px, ${m.y * -40 * f.depth}px, 0)`,
          transition: 'transform .35s ease-out',
          filter: `blur(${f.depth < 0.6 ? 1.5 : 0}px) drop-shadow(0 14px 18px rgba(0,0,0,.45))`,
          opacity: 0.35 + f.depth * 0.35,
          pointerEvents: 'none',
        }}>
        <Box sx={{ animation: `lgBob ${6 + i}s ${f.delay}s ease-in-out infinite` }}>
          <Cylinder size={f.size} tone={f.tone} />
        </Box>
      </Box>
    ))}
  </>
);

/**
 * The logo in a 3D scene: it hovers above a glowing platform, two rings turn around it at an angle, its shadow
 * breathes on the platform, and the whole scene leans towards the mouse.
 */
const Stage3D: FC<{ size: number; m: Tilt }> = ({ size, m }) => (
  <Box sx={{ position: 'relative', width: size * 1.45, height: size * 1.32, perspective: '1200px' }}>
    <Box
      sx={{
        position: 'absolute',
        inset: 0,
        transformStyle: 'preserve-3d',
        transform: `rotateX(${8 - m.y * 14}deg) rotateY(${m.x * 22}deg)`,
        transition: 'transform .3s ease-out',
      }}>
      {/* the platform: a round plinth under the logo - a dark side, a lit top, a glowing rim */}
      {[
        {
          dy: 14,
          bg: 'linear-gradient(180deg, #0B1D3F, #050D22)',
          shadow: '0 24px 40px rgba(0,0,0,.55)',
          rim: 'rgba(56,178,245,.35)',
        },
        {
          dy: 0,
          bg: 'radial-gradient(ellipse at 50% 45%, rgba(120,200,255,.55) 0%, rgba(29,111,224,.45) 40%, #0E2552 72%)',
          shadow: '0 0 50px rgba(56,178,245,.45)',
          rim: 'rgba(140,210,255,.9)',
        },
      ].map((d, i) => (
        <Box
          key={i}
          sx={{
            position: 'absolute',
            left: '50%',
            top: `calc(42% + ${size * 0.43 + d.dy}px)`,
            width: size * 0.92,
            height: size * 0.2,
            marginLeft: `${-size * 0.46}px`,
            borderRadius: '50%',
            background: d.bg,
            boxShadow: `${d.shadow}, inset 0 0 0 2px ${d.rim}`,
          }}
        />
      ))}
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: `calc(42% + ${size * 0.43 - size * 0.22}px)`,
          width: size * 0.5,
          height: size * 0.5,
          borderRadius: '50%',
          background: 'radial-gradient(closest-side, rgba(0,0,0,.55), transparent)',
          animation: 'lgShadow 6s ease-in-out infinite',
        }}
      />
      {/* the rings, tilted, turning around the logo */}
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: '42%',
          width: size * 1.28,
          height: size * 1.28,
          marginLeft: `${-size * 0.64}px`,
          marginTop: `${-size * 0.64}px`,
          borderRadius: '50%',
          border: `2px solid rgba(244,179,33,.65)`,
          transformStyle: 'preserve-3d',
          animation: 'lgOrbitA 16s linear infinite',
          '&::before': {
            content: '""',
            position: 'absolute',
            top: -7,
            left: '50%',
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: BRAND.gold,
            boxShadow: `0 0 16px ${BRAND.gold}`,
          },
        }}
      />
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: '42%',
          width: size * 1.1,
          height: size * 1.1,
          marginLeft: `${-size * 0.55}px`,
          marginTop: `${-size * 0.55}px`,
          borderRadius: '50%',
          border: `1.5px dashed rgba(56,178,245,.6)`,
          animation: 'lgOrbitB 24s linear infinite',
          '&::after': {
            content: '""',
            position: 'absolute',
            bottom: -6,
            left: '30%',
            width: 9,
            height: 9,
            borderRadius: '50%',
            background: BRAND.sky,
            boxShadow: `0 0 14px ${BRAND.sky}`,
          },
        }}
      />
      {/* a soft halo behind, then the logo in front of it */}
      <Box
        sx={{
          position: 'absolute',
          left: '50%',
          top: '42%',
          width: size,
          height: size,
          marginLeft: `${-size / 2}px`,
          marginTop: `${-size / 2}px`,
          borderRadius: '50%',
          transform: 'translateZ(-40px)',
          background: 'radial-gradient(circle, rgba(56,178,245,.45), transparent 65%)',
          animation: 'lgGlow 5s ease-in-out infinite',
        }}
      />
      <Box
        component="img"
        src={logo}
        alt={BRAND.name}
        data-logo="true"
        sx={{
          position: 'absolute',
          left: '50%',
          top: '42%',
          width: size,
          height: size,
          marginLeft: `${-size / 2}px`,
          marginTop: `${-size / 2}px`,
          animation: 'lgHover 6s ease-in-out infinite',
          filter: 'drop-shadow(0 26px 34px rgba(0,0,0,.5))',
        }}
      />
    </Box>
  </Box>
);

/**
 * autoNOMIC sign-in: username and password, checked by the API (local users today; LDAP / SSO providers plug in
 * on the server side without changing this page). A living network in the background, the logo turning in its
 * rings, the atmos CLI typing what the product does, and a glass sign-in card.
 */
const Login: FC = () => {
  const { t } = useTranslation('shared');
  const navigate = useNavigate();
  const location = useLocation();
  const isWide = useMediaQuery('(min-width: 1000px)');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [word, setWord] = useState(0);
  const [m, setM] = useState<Tilt>({ x: 0, y: 0 });
  const raf = useRef(0);
  const onMove = (e: MouseEvent) => {
    const x = e.clientX / window.innerWidth - 0.5;
    const y = e.clientY / window.innerHeight - 0.5;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setM({ x, y }));
  };
  useEffect(() => {
    const id = window.setInterval(() => setWord((w) => (w + 1) % WORDS.length), 2200);
    return () => window.clearInterval(id);
  }, []);

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

  const field = {
    '& .MuiOutlinedInput-root': {
      color: '#fff',
      background: 'rgba(255,255,255,0.06)',
      borderRadius: '12px',
      transition: 'box-shadow .2s, background .2s',
      '& fieldset': { borderColor: 'rgba(160,190,255,0.25)' },
      '&:hover fieldset': { borderColor: 'rgba(160,190,255,0.5)' },
      '&.Mui-focused': { background: 'rgba(255,255,255,0.09)', boxShadow: `0 0 0 4px rgba(56,178,245,0.18)` },
      '&.Mui-focused fieldset': { borderColor: BRAND.sky },
    },
    '& .MuiInputLabel-root': { color: 'rgba(220,230,250,0.7)' },
    '& .MuiInputLabel-root.Mui-focused': { color: BRAND.sky },
    '& .MuiSvgIcon-root': { color: 'rgba(220,230,250,0.7)' },
    '& input:-webkit-autofill': {
      WebkitBoxShadow: `0 0 0 100px ${BRAND.navy800} inset`,
      WebkitTextFillColor: '#fff',
      caretColor: '#fff',
    },
  };

  return (
    <Box
      data-surface="chrome"
      onMouseMove={onMove}
      onMouseLeave={() => setM({ x: 0, y: 0 })}
      sx={{
        ...anim,
        position: 'relative',
        minHeight: '100vh',
        overflow: 'hidden',
        color: BRAND.chromeText,
        background: `radial-gradient(900px 600px at 12% 18%, rgba(29,111,224,0.35), transparent 60%),
          radial-gradient(700px 500px at 92% 88%, rgba(244,179,33,0.16), transparent 60%),
          linear-gradient(150deg, ${BRAND.navy900} 0%, ${BRAND.navy800} 55%, #0A1640 100%)`,
      }}>
      <AnimatedNetwork />
      {/* the floor: a grid running towards you, to the horizon */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          left: '-60%',
          right: '-60%',
          bottom: 0,
          height: '150%',
          transform: `perspective(640px) rotateX(63deg) translateX(${m.x * -40}px)`,
          transformOrigin: 'center bottom',
          transition: 'transform .4s ease-out',
          backgroundImage: `linear-gradient(rgba(56,178,245,.45) 2px, transparent 2px),
            linear-gradient(90deg, rgba(56,178,245,.45) 2px, transparent 2px)`,
          backgroundSize: '72px 72px',
          animation: 'lgFloor 2.6s linear infinite',
          maskImage: 'linear-gradient(to top, black 30%, transparent 92%)',
        }}
      />
      {/* the horizon glow */}
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: '34%',
          height: 160,
          background: 'radial-gradient(60% 100% at 50% 100%, rgba(56,178,245,.22), transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      {isWide ? <Floaters m={m} /> : null}

      <Stack
        direction={isWide ? 'row' : 'column'}
        alignItems="center"
        justifyContent="center"
        gap={isWide ? '72px' : '28px'}
        sx={{ position: 'relative', zIndex: 1, minHeight: '100vh', px: { xs: 2.5, md: 6 }, py: 5 }}>
        {/* the story */}
        <Stack alignItems="center" gap="26px" sx={{ maxWidth: 520, animation: 'lgRise .8s ease both' }}>
          <Stage3D size={isWide ? 300 : 170} m={m} />
          {isWide ? (
            <>
              <Box textAlign="center">
                <Typography sx={{ fontWeight: 800, fontSize: '2.35rem', lineHeight: 1.12, letterSpacing: '-0.03em' }}>
                  {t('loginHeadline')}
                </Typography>
                <Stack direction="row" justifyContent="center" gap="8px" mt="18px" flexWrap="wrap">
                  {WORDS.map((w, k) => (
                    <Box
                      key={w}
                      sx={{
                        px: 1.4,
                        py: 0.5,
                        borderRadius: '999px',
                        fontSize: 13,
                        fontWeight: 700,
                        border: '1px solid',
                        transition: 'all .45s ease',
                        borderColor: k === word ? BRAND.gold : 'rgba(160,190,255,0.22)',
                        color: k === word ? '#1B1300' : BRAND.chromeMuted,
                        background: k === word ? BRAND.gold : 'rgba(255,255,255,0.03)',
                        boxShadow: k === word ? '0 0 22px rgba(244,179,33,0.45)' : 'none',
                        transform: k === word ? 'translateY(-2px)' : 'none',
                      }}>
                      <Box component="span" sx={{ color: k === word ? '#000' : BRAND.gold, fontWeight: 900 }}>
                        {w[0]}
                      </Box>
                      {w.slice(1)}
                    </Box>
                  ))}
                </Stack>
              </Box>
              <Terminal />
            </>
          ) : null}
        </Stack>

        {/* the sign-in card */}
        <Box
          sx={{
            perspective: '1200px',
            width: '100%',
            maxWidth: 410,
          }}>
          <Box
            style={{ transform: `rotateY(${m.x * -9}deg) rotateX(${m.y * 7}deg)` }}
            sx={{ transformStyle: 'preserve-3d', transition: 'transform .3s ease-out' }}>
            <Box
              component="form"
              onSubmit={handleSubmit(onSubmit)}
              noValidate
              sx={{
                width: '100%',
                maxWidth: 410,
                p: { xs: 3, sm: 4.5 },
                borderRadius: '22px',
                position: 'relative',
                background: 'linear-gradient(160deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03))',
                border: '1px solid rgba(160,190,255,0.22)',
                backdropFilter: 'blur(18px)',
                boxShadow: '0 30px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
                animation: 'lgRise .8s .15s ease both',
                '&::before': {
                  content: '""',
                  position: 'absolute',
                  top: 0,
                  left: 24,
                  right: 24,
                  height: '2px',
                  borderRadius: 2,
                  background: `linear-gradient(90deg, transparent, ${BRAND.gold}, ${BRAND.sky}, transparent)`,
                  backgroundSize: '200% 100%',
                  animation: 'lgShine 4s linear infinite',
                },
              }}>
              <Stack gap="20px">
                <Box>
                  <Stack direction="row" alignItems="center" gap={1.25} sx={{ mb: 1.5 }}>
                    <BrandMark size={38} />
                    <BrandName size="1.5rem" />
                  </Stack>
                  <Typography sx={{ fontWeight: 800, fontSize: '1.6rem', letterSpacing: '-0.02em', color: '#fff' }}>
                    {t('signIn')}
                  </Typography>
                  <Typography sx={{ color: BRAND.chromeMuted, mt: 0.5 }}>{t('signInSubtitle')}</Typography>
                </Box>
                {error ? (
                  <Alert severity="error" variant="filled" sx={{ borderRadius: '12px' }}>
                    {error}
                  </Alert>
                ) : null}
                <Controller
                  control={control}
                  name={LOGIN_FORM_FIELD_NAMES.USERNAME}
                  render={({ field: f }) => (
                    <TextField
                      {...f}
                      required
                      autoFocus
                      fullWidth
                      label={t('username')}
                      autoComplete="username"
                      sx={field}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <PersonOutline />
                            </InputAdornment>
                          ),
                        },
                      }}
                    />
                  )}
                />
                <Controller
                  control={control}
                  name={LOGIN_FORM_FIELD_NAMES.PASSWORD}
                  render={({ field: f }) => (
                    <TextField
                      {...f}
                      required
                      fullWidth
                      type={showPassword ? 'text' : 'password'}
                      label={t('password')}
                      autoComplete="current-password"
                      sx={field}
                      slotProps={{
                        input: {
                          startAdornment: (
                            <InputAdornment position="start">
                              <LockOutlined />
                            </InputAdornment>
                          ),
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
                  endIcon={isLoading ? <CircularProgress size={18} color="inherit" /> : <ArrowForward />}
                  sx={{
                    py: '13px',
                    borderRadius: '12px',
                    fontWeight: 800,
                    fontSize: '1rem',
                    color: '#fff',
                    background: `linear-gradient(90deg, ${BRAND.blue}, #2F8BFF 50%, ${BRAND.blue})`,
                    backgroundSize: '200% 100%',
                    boxShadow: '0 10px 30px rgba(29,111,224,0.45)',
                    transition: 'transform .15s, box-shadow .2s, background-position .6s',
                    '&:hover': {
                      backgroundPosition: '100% 0',
                      transform: 'translateY(-1px)',
                      boxShadow: '0 14px 36px rgba(29,111,224,0.55)',
                    },
                    '&.Mui-disabled': { color: 'rgba(255,255,255,0.8)' },
                  }}>
                  {isLoading ? t('signingIn') : t('signIn')}
                </Button>
                <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                  <Typography sx={{ fontSize: 12, color: BRAND.chromeMuted }}>
                    v{version} · {t('productLine')}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: BRAND.chromeMuted }}>
                    {t('basedOn')}{' '}
                    <Link
                      href="https://github.com/autobase-tech/autobase"
                      target="_blank"
                      rel="noreferrer"
                      underline="hover"
                      sx={{ color: BRAND.sky }}>
                      Autobase
                    </Link>{' '}
                    (MIT)
                  </Typography>
                </Stack>
              </Stack>
              {/* light that follows the mouse across the glass */}
              <Box
                aria-hidden
                sx={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '22px',
                  pointerEvents: 'none',
                  background: `radial-gradient(420px circle at ${50 + m.x * 120}% ${30 + m.y * 120}%, rgba(255,255,255,.10), transparent 45%)`,
                }}
              />
            </Box>
          </Box>
        </Box>
      </Stack>
      <Typography
        sx={{
          position: 'absolute',
          bottom: 14,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 12,
          letterSpacing: '0.06em',
          color: 'rgba(230,237,248,0.38)',
          zIndex: 1,
        }}>
        Managed by Keen &amp; Able Computers Pvt. Ltd.
      </Typography>
    </Box>
  );
};

export default Login;
