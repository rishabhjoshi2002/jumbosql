import { FC, ReactNode } from 'react';
import { Box, LinearProgress, Stack, Typography } from '@mui/material';
import { alpha, useTheme } from '@mui/material/styles';
import { useTranslation } from 'react-i18next';
import { Link as RouterLink } from 'react-router-dom';
import AddRounded from '@mui/icons-material/AddRounded';
import TerminalRounded from '@mui/icons-material/TerminalRounded';
import SettingsBackupRestoreRounded from '@mui/icons-material/SettingsBackupRestoreRounded';
import TravelExploreRounded from '@mui/icons-material/TravelExploreRounded';
import UpgradeRounded from '@mui/icons-material/UpgradeRounded';
import ArrowForwardRounded from '@mui/icons-material/ArrowForwardRounded';
import CheckCircleOutlineRounded from '@mui/icons-material/CheckCircleOutlineRounded';
import ErrorOutlineRounded from '@mui/icons-material/ErrorOutlineRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import PriorityHighRounded from '@mui/icons-material/PriorityHighRounded';
import DnsRounded from '@mui/icons-material/DnsRounded';
import DataUsageRounded from '@mui/icons-material/DataUsageRounded';
import StorageRounded from '@mui/icons-material/StorageRounded';
import RouterPaths from '@app/router/routerPathsConfig';
import { Fleet, FleetCluster } from '@shared/api/api/insights.ts';
import { canAny, SessionUser } from '@shared/lib/session.ts';
import { BRAND } from '@shared/theme/theme.ts';
import { BrandLogo } from '@shared/ui/brand';
import { bytes } from '@pages/insights/lib/format.ts';
import { version } from '../../../../package.json';

/** KeenPG home: a welcome card with quick actions, the fleet in numbers, and one card per cluster. */

const GRAD = {
  violet: `linear-gradient(135deg, #6A55E8 0%, ${BRAND.violet} 100%)`,
  blue: 'linear-gradient(135deg, #4F8DF7 0%, #2F6BE0 100%)',
  orange: `linear-gradient(135deg, #FFBA3B 0%, ${BRAND.orangeDeep} 100%)`,
  lilac: 'linear-gradient(135deg, #9B8CFF 0%, #7461EA 100%)',
  green: 'linear-gradient(135deg, #3FCB8A 0%, #1E9E62 100%)',
  grey: 'linear-gradient(135deg, #B9B4CF 0%, #8E88AA 100%)',
  red: 'linear-gradient(135deg, #F27373 0%, #D64545 100%)',
};

/** a rounded square with a white icon on a gradient */
const Chip: FC<{ grad: string; size?: number; children: ReactNode }> = ({ grad, size = 40, children }) => (
  <Box
    className="kp-chip"
    sx={{
      width: size,
      height: size,
      borderRadius: `${Math.round(size * 0.3)}px`,
      background: grad,
      display: 'grid',
      placeItems: 'center',
      flexShrink: 0,
      boxShadow: '0 4px 10px -4px rgba(38, 28, 81, 0.35)',
      '& svg': { fontSize: size * 0.55 },
    }}>
    {children}
  </Box>
);

const card = {
  bgcolor: 'background.paper',
  border: 1,
  borderColor: 'divider',
  borderRadius: '16px',
  boxShadow: '0 6px 20px -14px rgba(38, 28, 81, 0.25)',
} as const;

/** a small outlined pill */
const Pill: FC<{ children: ReactNode; color?: string; icon?: ReactNode }> = ({ children, color, icon }) => (
  <Stack
    direction="row"
    alignItems="center"
    gap={0.75}
    sx={{
      px: 1.25,
      py: 0.5,
      borderRadius: 99,
      border: 1.5,
      borderColor: color ?? 'divider',
      color: color ?? 'text.primary',
      fontSize: '0.82rem',
      fontWeight: 700,
      whiteSpace: 'nowrap',
      bgcolor: 'background.paper',
      '& svg': { fontSize: 18 },
    }}>
    {icon}
    {children}
  </Stack>
);

/* ----------------------------------------------------------- welcome ----------------------------------------------------------- */

export const HomeHero: FC<{ greeting: string; fleet?: Fleet; user: SessionUser | null; pages: string[] }> = ({
  greeting,
  fleet,
  user,
  pages,
}) => {
  const { t } = useTranslation('shared');
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const has = (p: string) => pages.includes(p);
  const actions = [
    canAny(['clusters.manage'], undefined, user) && {
      to: RouterPaths.clusters.add.absolutePath,
      icon: <AddRounded />,
      grad: GRAD.violet,
      title: t('hq_create'),
      sub: t('hq_createSub'),
    },
    has(RouterPaths.sqlEditor.absolutePath) && {
      to: RouterPaths.sqlEditor.absolutePath,
      icon: <TerminalRounded />,
      grad: GRAD.blue,
      title: t('hq_sql'),
      sub: t('hq_sqlSub'),
    },
    has(RouterPaths.backups.absolutePath) && {
      to: RouterPaths.backups.absolutePath,
      icon: <SettingsBackupRestoreRounded />,
      grad: GRAD.orange,
      title: t('hq_backup'),
      sub: t('hq_backupSub'),
    },
    has(RouterPaths.discover.absolutePath) && {
      to: RouterPaths.discover.absolutePath,
      icon: <TravelExploreRounded />,
      grad: GRAD.lilac,
      title: t('hq_discover'),
      sub: t('hq_discoverSub'),
    },
    has(RouterPaths.upgrade.absolutePath) && {
      to: RouterPaths.upgrade.absolutePath,
      icon: <UpgradeRounded />,
      grad: GRAD.green,
      title: t('hq_upgrade'),
      sub: t('hq_upgradeSub'),
    },
  ].filter(Boolean) as { to: string; icon: ReactNode; grad: string; title: string; sub: string }[];

  const up = (fleet?.clusters ?? []).reduce((n, c) => n + c.healthy, 0);
  const total = fleet?.totals.servers ?? 0;
  const versions = [
    ...new Set((fleet?.clusters ?? []).map((c) => c.summary?.version?.split('.')[0]).filter(Boolean)),
  ].sort((a, b) => Number(a) - Number(b));

  return (
    <Box
      sx={{
        ...card,
        borderRadius: '22px',
        p: { xs: 2.5, md: 3.5 },
        background: dark
          ? 'linear-gradient(100deg, #17142B 0%, #1B1734 55%, #2A1F2C 100%)'
          : 'linear-gradient(100deg, #FFFFFF 0%, #FFFFFF 42%, #F5F2FF 72%, #FFF3E3 100%)',
        display: 'grid',
        gap: 3,
        gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 1.15fr) minmax(0, 1fr)' },
        alignItems: 'center',
      }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ xs: 'flex-start', sm: 'center' }} gap={3}>
        <BrandLogo width={180} onDark={dark} sx={{ flexShrink: 0 }} />
        <Box minWidth={0}>
          <Typography
            component="h1"
            sx={{
              fontSize: { xs: '1.6rem', md: '2.05rem' },
              fontWeight: 800,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
              color: dark ? '#ECE9FF' : BRAND.ink,
            }}>
            {greeting}
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.75, fontSize: '1.02rem', lineHeight: 1.5 }}>
            {t('homeHeroSub')}
          </Typography>
          <Stack direction="row" gap={1} mt={2} flexWrap="wrap">
            {fleet ? (
              <Pill
                color={up === total ? 'success.main' : 'warning.main'}
                icon={
                  up === total ? (
                    <CheckCircleOutlineRounded color="success" />
                  ) : (
                    <ErrorOutlineRounded color="warning" />
                  )
                }>
                {t('homeNodesUp', { up, total })}
              </Pill>
            ) : null}
            <Pill>KeenPG {version}</Pill>
            {versions.length ? <Pill>PostgreSQL {versions.join(' · ')}</Pill> : null}
          </Stack>
        </Box>
      </Stack>

      {actions.length ? (
        <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, minmax(0, 1fr))' } }}>
          {actions.map((a) => (
            <Stack
              key={a.to}
              component={RouterLink}
              to={a.to}
              direction="row"
              alignItems="center"
              gap={1.5}
              sx={{
                ...card,
                borderRadius: '14px',
                p: 1.5,
                minWidth: 0,
                color: 'inherit',
                textDecoration: 'none',
                transition: 'border-color .15s, transform .15s, box-shadow .15s',
                '&:hover': {
                  borderColor: 'primary.main',
                  transform: 'translateY(-1px)',
                  boxShadow: `0 10px 24px -14px ${alpha(BRAND.violet, 0.55)}`,
                },
                '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
              }}>
              <Chip grad={a.grad}>{a.icon}</Chip>
              <Box flex={1} minWidth={0}>
                <Typography fontWeight={700} fontSize="0.95rem" noWrap>
                  {a.title}
                </Typography>
                <Typography variant="body2" color="text.secondary" noWrap>
                  {a.sub}
                </Typography>
              </Box>
              <ArrowForwardRounded sx={{ fontSize: 20, opacity: 0.6 }} />
            </Stack>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

/* ------------------------------------------------------------ numbers ------------------------------------------------------------ */

type State = 'healthy' | 'attention' | 'down' | 'nodata';
const stateOf = (c: FleetCluster): State =>
  c.summary?.unreachable
    ? 'down'
    : !c.summary
      ? 'nodata'
      : c.summary.critical || c.summary.warning || c.healthy < c.servers
        ? 'attention'
        : 'healthy';
const STATE_COLOR: Record<State, string> = {
  healthy: 'success.main',
  attention: 'warning.main',
  down: 'error.main',
  nodata: 'text.disabled',
};

/** a ring split by cluster state, with the cluster count in the middle */
const Donut: FC<{ parts: { n: number; color: string }[]; total: number }> = ({ parts, total }) => {
  const theme = useTheme();
  const size = 92;
  const r = 38;
  const c = 2 * Math.PI * r;
  const pick = (k: string) => {
    const [p, s] = k.split('.');
    return (theme.palette as unknown as Record<string, Record<string, string>>)[p]?.[s] ?? k;
  };
  let at = 0;
  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={theme.palette.divider} strokeWidth="9" />
        {total
          ? parts.map((p, i) => {
              const len = (p.n / total) * c;
              const el = p.n ? (
                <circle
                  key={i}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={pick(p.color)}
                  strokeWidth="9"
                  strokeDasharray={`${len} ${c - len}`}
                  strokeDashoffset={-at}
                />
              ) : null;
              at += len;
              return el;
            })
          : null}
      </svg>
      <Typography
        sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 26 }}>
        {total}
      </Typography>
    </Box>
  );
};

const Stat: FC<{ grad: string; icon: ReactNode; value: ReactNode; label: string; sub: string }> = ({
  grad,
  icon,
  value,
  label,
  sub,
}) => (
  <Stack direction="row" alignItems="center" gap={2} sx={{ ...card, p: 2.5, minWidth: 0 }}>
    <Chip grad={grad} size={46}>
      {icon}
    </Chip>
    <Box minWidth={0}>
      <Typography sx={{ fontSize: '1.9rem', fontWeight: 800, lineHeight: 1.05, letterSpacing: '-0.02em' }} noWrap>
        {value}
      </Typography>
      <Typography fontWeight={700} fontSize="0.95rem" noWrap>
        {label}
      </Typography>
      <Typography variant="body2" color="text.secondary" noWrap>
        {sub}
      </Typography>
    </Box>
  </Stack>
);

export const FleetNumbers: FC<{ fleet: Fleet }> = ({ fleet }) => {
  const { t } = useTranslation('shared');
  const list = fleet.clusters ?? [];
  const count = (s: State) => list.filter((c) => stateOf(c) === s).length;
  const healthy = count('healthy');
  const attention = count('attention') + count('down');
  const x = fleet.totals;
  const up = list.reduce((n, c) => n + c.healthy, 0);
  const pct = list.length ? Math.round((healthy / list.length) * 100) : 0;
  const legend: { s: State; label: string }[] = [
    { s: 'healthy', label: t('hn_healthy') },
    { s: 'attention', label: t('hn_attention') },
    { s: 'down', label: t('hn_down') },
    { s: 'nodata', label: t('hn_nodata') },
  ];
  return (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: {
          xs: 'minmax(0, 1fr)',
          sm: 'repeat(2, minmax(0, 1fr))',
          xl: 'minmax(0, 1.3fr) repeat(4, minmax(0, 1fr))',
        },
      }}>
      <Stack direction="row" alignItems="center" gap={2.5} sx={{ ...card, p: 2.5, minWidth: 0 }}>
        <Donut parts={legend.map((l) => ({ n: count(l.s), color: STATE_COLOR[l.s] }))} total={list.length} />
        <Box minWidth={0} flex={1}>
          <Typography fontWeight={800} fontSize="1.05rem" mb={0.5}>
            {t('hs_clusters')}
          </Typography>
          {legend.map((l) => (
            <Stack key={l.s} direction="row" alignItems="center" gap={1} sx={{ fontSize: '0.86rem', lineHeight: 1.7 }}>
              <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: STATE_COLOR[l.s], flexShrink: 0 }} />
              <Box flex={1} color="text.secondary">
                {l.label}
              </Box>
              <Box fontWeight={700}>{count(l.s)}</Box>
            </Stack>
          ))}
        </Box>
      </Stack>
      <Stat
        grad={GRAD.green}
        icon={<CheckRounded />}
        value={healthy}
        label={t('hn_healthy')}
        sub={t('hn_ofFleet', { pct })}
      />
      <Stat
        grad={attention ? GRAD.red : GRAD.grey}
        icon={<PriorityHighRounded />}
        value={attention}
        label={t('hn_attention')}
        sub={x.critical || x.warning ? t('hn_findings', { c: x.critical, w: x.warning }) : t('hs_allGood')}
      />
      <Stat
        grad={GRAD.violet}
        icon={<DnsRounded />}
        value={`${up} / ${x.servers}`}
        label={t('hs_nodes')}
        sub={up === x.servers ? t('hn_allRunning') : t('hn_someDown', { n: x.servers - up })}
      />
      <Stat
        grad={GRAD.orange}
        icon={<DataUsageRounded />}
        value={bytes(x.size_bytes)}
        label={t('hs_data')}
        sub={t('hs_inYear', { size: bytes(x.size_in_365) })}
      />
    </Box>
  );
};

/* ------------------------------------------------------------ clusters ------------------------------------------------------------ */

export const FleetClusterCards: FC<{ fleet: Fleet; onOpen: (id: number) => void }> = ({ fleet, onOpen }) => {
  const { t } = useTranslation('shared');
  const list = fleet.clusters ?? [];
  if (!list.length) return <Typography color="text.secondary">{t('homeNoClusters')}</Typography>;
  const label: Record<State, string> = {
    healthy: t('hn_stHealthy'),
    attention: t('hn_stAttention'),
    down: t('hs_unreachable'),
    nodata: t('hs_noData'),
  };
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
      {list.map((c) => {
        const s = c.summary;
        const st = stateOf(c);
        const col = STATE_COLOR[st];
        return (
          <Box
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(c.id)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
            sx={{
              ...card,
              overflow: 'hidden',
              cursor: 'pointer',
              transition: 'border-color .15s, transform .15s',
              '&:hover': { borderColor: 'primary.main', transform: 'translateY(-1px)' },
              '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
            }}>
            <Box sx={{ height: 5, bgcolor: col }} />
            <Box p={2.25}>
              <Stack direction="row" alignItems="center" gap={1.5}>
                <Chip grad={st === 'healthy' ? GRAD.green : st === 'attention' ? GRAD.orange : GRAD.grey}>
                  <StorageRounded />
                </Chip>
                <Box flex={1} minWidth={0}>
                  <Typography fontWeight={800} fontSize="1.02rem" noWrap>
                    {c.name}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {s?.score !== undefined && s?.score !== null ? t('hn_score', { n: Math.round(s.score) }) : c.status}
                  </Typography>
                </Box>
                <Pill color={col}>{label[st]}</Pill>
              </Stack>
              <Stack direction="row" alignItems="center" justifyContent="space-between" mt={2} gap={1}>
                {s?.version ? (
                  <Box
                    sx={{
                      px: 1,
                      py: 0.25,
                      borderRadius: '8px',
                      fontSize: '0.8rem',
                      fontWeight: 700,
                      bgcolor: (th) => alpha(th.palette.primary.main, 0.12),
                      color: 'primary.main',
                    }}>
                    PostgreSQL {s.version.split('.')[0]}
                  </Box>
                ) : (
                  <span />
                )}
                <Typography variant="body2" color="text.secondary">
                  {t('hn_nodesReady', { up: c.healthy, total: c.servers })}
                </Typography>
              </Stack>
              <LinearProgress
                variant="determinate"
                value={c.servers ? (c.healthy / c.servers) * 100 : 0}
                sx={{
                  mt: 1,
                  height: 6,
                  borderRadius: 3,
                  '& .MuiLinearProgress-bar': {
                    borderRadius: 3,
                    backgroundColor: (th) => (c.healthy === c.servers ? th.palette.success.main : th.palette.warning.main),
                  },
                }}
              />
              <Typography variant="body2" color="text.secondary" mt={1.5} noWrap>
                {c.leader ? `${t('hs_leader')} ${c.leader}` : '—'}
              </Typography>
              <Stack direction="row" gap={1} mt={1.25} flexWrap="wrap">
                <Pill color="primary.main">{bytes(s?.size_bytes ?? 0)}</Pill>
                {s?.critical ? <Pill color="error.main">{t('hs_nCritical', { n: s.critical })}</Pill> : null}
                {s?.warning ? <Pill color="warning.main">{t('hs_nWarning', { n: s.warning })}</Pill> : null}
                {s && !s.critical && !s.warning && !s.unreachable ? (
                  <Pill color="success.main">{t('hs_allGood')}</Pill>
                ) : null}
              </Stack>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
};
