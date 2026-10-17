import { FC, ReactNode, useEffect, useState } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Fleet, FleetCluster } from '@shared/api/api/insights.ts';
import { bytes, signed } from '@pages/insights/lib/format.ts';
import { BRAND } from '@shared/theme/theme.ts';
import AnimatedNetwork from '@shared/ui/animated-network';

/** autoNOMIC home: the visual building blocks (hero, health rings, cluster tiles, risk list, shortcut tiles). */

export const homeAnim = {
  '@keyframes hmRise': { from: { opacity: 0, transform: 'translateY(14px)' }, to: { opacity: 1, transform: 'none' } },
  '@keyframes hmPulse': { '0%,100%': { boxShadow: '0 0 0 0 rgba(52,199,89,0.55)' }, '70%': { boxShadow: '0 0 0 7px rgba(52,199,89,0)' } },
  '@keyframes hmSweep': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
  '@media (prefers-reduced-motion: reduce)': { '& *': { animation: 'none !important', transition: 'none !important' } },
};

export const toneOf = (score?: number) =>
  score === undefined || score === null ? '#8A99B4' : score >= 85 ? '#22C55E' : score >= 60 ? '#F59E0B' : '#EF4444';

/** a ring that fills up to the score when it appears */
export const HealthRing: FC<{ score?: number; size?: number; stroke?: number; label?: ReactNode; dark?: boolean }> = ({
  score,
  size = 120,
  stroke = 10,
  label,
  dark,
}) => {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = window.setTimeout(() => setShown(score ?? 0), 60);
    return () => window.clearTimeout(id);
  }, [score]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const tone = toneOf(score);
  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={dark ? 'rgba(255,255,255,0.12)' : 'rgba(120,140,170,0.18)'} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - Math.min(100, Math.max(0, shown)) / 100)}
          style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1)', filter: `drop-shadow(0 0 6px ${tone}88)` }}
        />
      </svg>
      <Stack sx={{ position: 'absolute', inset: 0 }} alignItems="center" justifyContent="center">
        <Typography sx={{ fontWeight: 900, fontSize: size * 0.27, lineHeight: 1, color: dark ? '#fff' : 'text.primary' }}>
          {score === undefined || score === null ? '—' : Math.round(score)}
        </Typography>
        {label ? (
          <Typography sx={{ fontSize: Math.max(10, size * 0.095), fontWeight: 700, color: dark ? BRAND.chromeMuted : 'text.secondary', mt: 0.3 }}>
            {label}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
};

const Pill: FC<{ value: ReactNode; label: string; color: string }> = ({ value, label, color }) => (
  <Box
    sx={{
      px: 1.75,
      py: 1.1,
      minWidth: 108,
      borderRadius: '14px',
      background: 'rgba(255,255,255,0.06)',
      border: '1px solid rgba(255,255,255,0.10)',
      backdropFilter: 'blur(6px)',
    }}>
    <Stack direction="row" alignItems="center" gap={0.75}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', background: color, boxShadow: `0 0 10px ${color}` }} />
      <Typography sx={{ fontSize: 12, color: BRAND.chromeMuted, fontWeight: 600 }}>{label}</Typography>
    </Stack>
    <Typography sx={{ fontSize: 22, fontWeight: 800, color: '#fff', mt: 0.25 }}>{value}</Typography>
  </Box>
);

/** the top of the home page: greeting, today, the fleet's health ring and the numbers that matter */
export const Hero: FC<{
  greeting: string;
  subtitle: string;
  fleet?: Fleet;
  clusters: number;
  nodes: number;
  nodesUp: number;
}> = ({ greeting, subtitle, fleet, clusters, nodes, nodesUp }) => {
  const { t } = useTranslation('shared');
  const x = fleet?.totals;
  const allUp = nodes > 0 && nodesUp === nodes;
  return (
    <Box
      data-surface="chrome"
      sx={{
        position: 'relative',
        overflow: 'hidden',
        borderRadius: '22px',
        color: BRAND.chromeText,
        px: { xs: 2.5, md: 4 },
        py: { xs: 2.5, md: 3.5 },
        background: `radial-gradient(600px 300px at 85% 20%, rgba(56,178,245,0.30), transparent 60%),
          radial-gradient(500px 260px at 10% 120%, rgba(244,179,33,0.18), transparent 60%),
          linear-gradient(135deg, ${BRAND.navy900}, ${BRAND.navy700})`,
        boxShadow: '0 18px 50px rgba(7,15,43,0.25)',
        animation: 'hmRise .6s ease both',
      }}>
      <AnimatedNetwork density={0.45} />
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        alignItems={{ xs: 'flex-start', md: 'center' }}
        gap={3}
        sx={{ position: 'relative', zIndex: 1 }}>
        <Box flex={1} minWidth={0}>
          <Typography sx={{ color: BRAND.gold, fontWeight: 800, letterSpacing: '0.14em', fontSize: 12 }}>
            {new Date()
              .toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
              .toUpperCase()}
          </Typography>
          <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.6rem', md: '2.1rem' }, letterSpacing: '-0.02em', mt: 0.5, color: '#fff' }}>
            {greeting}
          </Typography>
          <Typography sx={{ color: BRAND.chromeMuted, mt: 0.5 }}>{subtitle}</Typography>
          <Stack direction="row" alignItems="center" gap={1} mt={2}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: allUp ? '#34C759' : nodes ? '#F59E0B' : '#8A99B4',
                animation: allUp ? 'hmPulse 2s infinite' : 'none',
              }}
            />
            <Typography sx={{ fontWeight: 700, color: '#fff' }}>
              {nodes
                ? allUp
                  ? t('hm_allUp', { clusters, nodes })
                  : t('hm_someDown', { down: nodes - nodesUp, nodes })
                : t('hm_noClusters')}
            </Typography>
          </Stack>
        </Box>
        {x ? (
          <Stack direction="row" alignItems="center" gap={3} flexWrap="wrap">
            <Stack alignItems="center" gap={0.5}>
              <HealthRing score={x.clusters ? x.avg_score : undefined} size={132} stroke={11} label={t('hm_health')} dark />
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, auto)', gap: 1.25 }}>
              <Pill value={x.critical} label={t('hm_critical')} color="#EF4444" />
              <Pill value={x.warning} label={t('hm_warnings')} color="#F59E0B" />
              <Pill value={bytes(x.size_bytes)} label={t('hm_data')} color={BRAND.sky} />
              <Pill value={bytes(x.size_in_365)} label={t('hm_inYear')} color={BRAND.gold} />
            </Box>
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
};

/** nodes up, as dots */
const Dots: FC<{ up: number; all: number }> = ({ up, all }) => (
  <Stack direction="row" gap={0.5} flexWrap="wrap">
    {Array.from({ length: Math.min(all, 12) }, (_, i) => (
      <Box key={i} sx={{ width: 9, height: 9, borderRadius: '3px', background: i < up ? '#22C55E' : '#EF4444', opacity: 0.9 }} />
    ))}
  </Stack>
);

/** one tile per cluster: health ring, nodes, data and where it is going, findings */
export const ClusterTiles: FC<{ fleet: Fleet; onOpen: (id: number) => void }> = ({ fleet, onOpen }) => {
  const { t } = useTranslation(['shared', 'insights']);
  const list: FleetCluster[] = fleet.clusters ?? [];
  if (!list.length) return <Typography color="text.secondary">{t('homeNoClusters')}</Typography>;
  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
      {list.map((c, i) => {
        const s = c.summary;
        const grow = s && s.size_bytes && s.size_in_365 > 0 ? Math.min(100, (s.size_bytes / Math.max(s.size_in_365, s.size_bytes)) * 100) : 0;
        return (
          <Box
            key={c.id}
            onClick={() => onOpen(c.id)}
            sx={{
              cursor: 'pointer',
              p: 2,
              borderRadius: '16px',
              border: 1,
              borderColor: 'divider',
              bgcolor: 'background.paper',
              position: 'relative',
              overflow: 'hidden',
              transition: 'transform .18s, box-shadow .18s, border-color .18s',
              animation: `hmRise .5s ${0.05 * i}s ease both`,
              '&::before': {
                content: '""',
                position: 'absolute',
                inset: '0 0 auto 0',
                height: 3,
                background: `linear-gradient(90deg, ${toneOf(s?.score)}, transparent)`,
              },
              '&:hover': { transform: 'translateY(-3px)', boxShadow: '0 14px 30px rgba(16,30,70,0.14)', borderColor: 'primary.main' },
            }}>
            <Stack direction="row" gap={1.5} alignItems="center">
              <HealthRing score={s?.score} size={64} stroke={7} />
              <Box minWidth={0} flex={1}>
                <Typography fontWeight={800} noWrap>
                  {c.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">
                  {c.leader ? `${t('hm_leader')} ${c.leader}` : c.status}
                  {s?.version ? ` · PostgreSQL ${s.version}` : ''}
                </Typography>
                <Box mt={0.75}>
                  <Dots up={c.healthy} all={c.servers} />
                </Box>
              </Box>
            </Stack>
            <Box mt={1.5}>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary" fontWeight={700}>
                  {t('hm_data')} {bytes(s?.size_bytes ?? 0)}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {t('hm_inYear')} {s && s.size_in_365 > 0 ? bytes(s.size_in_365) : '—'}
                </Typography>
              </Stack>
              <Box sx={{ mt: 0.5, height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                <Box
                  sx={{
                    height: '100%',
                    width: `${grow}%`,
                    borderRadius: 3,
                    background: `linear-gradient(90deg, ${BRAND.blue}, ${BRAND.sky})`,
                    transition: 'width 1.2s ease',
                  }}
                />
              </Box>
            </Box>
            <Stack direction="row" gap={0.75} mt={1.25} flexWrap="wrap">
              {s?.unreachable ? (
                <Badge color="#EF4444" text={t('hm_unreachable')} />
              ) : s ? (
                <>
                  {s.critical ? <Badge color="#EF4444" text={t('hm_nCritical', { n: s.critical })} /> : null}
                  {s.warning ? <Badge color="#F59E0B" text={t('hm_nWarning', { n: s.warning })} /> : null}
                  {!s.critical && !s.warning ? <Badge color="#22C55E" text={t('hm_allGood')} /> : null}
                  {s.size_per_day ? (
                    <Tooltip title={t('hm_perDay')}>
                      <Box>
                        <Badge color={BRAND.sky} text={`${signed(bytes(s.size_per_day), s.size_per_day)}/${t('hm_day')}`} />
                      </Box>
                    </Tooltip>
                  ) : null}
                </>
              ) : (
                <Badge color="#8A99B4" text={t('hm_noData')} />
              )}
            </Stack>
          </Box>
        );
      })}
    </Box>
  );
};

export const Badge: FC<{ color: string; text: string }> = ({ color, text }) => (
  <Box
    component="span"
    sx={{
      px: 1,
      py: '2px',
      borderRadius: '999px',
      fontSize: 11.5,
      fontWeight: 800,
      color,
      background: `${color}1F`,
      border: `1px solid ${color}55`,
      whiteSpace: 'nowrap',
    }}>
    {text}
  </Box>
);

/** a panel of the home page: an icon, a title, an action, and a soft lift on hover */
export const Panel: FC<{ title: string; icon?: ReactNode; action?: ReactNode; children: ReactNode; wide?: boolean; delay?: number }> = ({
  title,
  icon,
  action,
  children,
  wide,
  delay = 0,
}) => (
  <Box
    sx={{
      gridColumn: wide ? '1 / -1' : undefined,
      border: 1,
      borderColor: 'divider',
      borderRadius: '18px',
      p: 2.25,
      bgcolor: 'background.paper',
      minWidth: 0,
      boxShadow: '0 1px 2px rgba(16,30,70,0.04)',
      animation: `hmRise .55s ${delay}s ease both`,
      transition: 'box-shadow .2s',
      '&:hover': { boxShadow: '0 10px 30px rgba(16,30,70,0.08)' },
    }}>
    <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1.5} gap={1}>
      <Stack direction="row" alignItems="center" gap={1.25}>
        {icon ? (
          <Box
            sx={{
              width: 34,
              height: 34,
              borderRadius: '10px',
              display: 'grid',
              placeItems: 'center',
              color: '#fff',
              background: `linear-gradient(135deg, ${BRAND.blue}, ${BRAND.navy700})`,
              boxShadow: '0 6px 14px rgba(29,111,224,0.3)',
              '& svg': { fontSize: 19 },
            }}>
            {icon}
          </Box>
        ) : null}
        <Typography fontWeight={800} fontSize="1.02rem">
          {title}
        </Typography>
      </Stack>
      {action}
    </Stack>
    {children}
  </Box>
);
