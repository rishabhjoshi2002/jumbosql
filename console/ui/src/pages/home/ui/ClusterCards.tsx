import { FC, ReactNode } from 'react';
import { Box, Divider, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { Fleet } from '@shared/api/api/insights.ts';
import { bytes } from '@pages/insights/lib/format.ts';

/** home page: a quiet summary line and one card per cluster - plain theme colours, no decoration for its own sake */

const tone = (score?: number) =>
  score === undefined || score === null
    ? 'text.disabled'
    : score >= 85
      ? 'success.main'
      : score >= 60
        ? 'warning.main'
        : 'error.main';

/** a thin ring with the health score inside */
const Ring: FC<{ score?: number; size?: number }> = ({ score, size = 52 }) => {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, score ?? 0));
  return (
    <Box sx={{ position: 'relative', width: size, height: size, flexShrink: 0, color: tone(score) }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity="0.15"
          strokeWidth="4"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
        />
      </svg>
      <Typography
        sx={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontWeight: 700,
          fontSize: size * 0.3,
          color: 'text.primary',
        }}>
        {score === undefined || score === null ? '—' : Math.round(score)}
      </Typography>
    </Box>
  );
};

const Dot: FC<{ color: string }> = ({ color }) => (
  <Box
    component="span"
    sx={{
      display: 'inline-block',
      width: 7,
      height: 7,
      borderRadius: '50%',
      bgcolor: color,
      mr: 0.75,
      verticalAlign: 'middle',
    }}
  />
);

const Fact: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <Box>
    <Typography variant="caption" color="text.secondary" display="block">
      {label}
    </Typography>
    <Typography fontWeight={700} fontSize={15} noWrap>
      {children}
    </Typography>
  </Box>
);

/** "2 clusters · 4 / 4 nodes up · health 62 · 1 critical, 5 warnings · 97 MB" */
export const SummaryLine: FC<{ fleet: Fleet }> = ({ fleet }) => {
  const { t } = useTranslation('shared');
  const x = fleet.totals;
  const up = (fleet.clusters ?? []).reduce((n, c) => n + c.healthy, 0);
  return (
    <Stack
      direction="row"
      divider={<Divider orientation="vertical" flexItem />}
      gap={2.5}
      flexWrap="wrap"
      sx={{ border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper', px: 2.5, py: 1.5 }}>
      <Fact label={t('hs_clusters')}>{x.clusters}</Fact>
      <Fact label={t('hs_nodes')}>
        <Dot color={up === x.servers ? 'success.main' : 'warning.main'} />
        {up} / {x.servers}
      </Fact>
      <Fact label={t('hs_health')}>
        <Box component="span" sx={{ color: tone(x.clusters ? x.avg_score : undefined) }}>
          {x.clusters ? x.avg_score : '—'}
        </Box>
        <Typography component="span" variant="caption" color="text.secondary" ml={0.75}>
          {t('hs_worst', { n: x.worst_score })}
        </Typography>
      </Fact>
      <Fact label={t('hs_findings')}>
        <Dot color="error.main" />
        {x.critical}
        <Box component="span" sx={{ mx: 1.25 }} />
        <Dot color="warning.main" />
        {x.warning}
      </Fact>
      <Fact label={t('hs_data')}>
        {bytes(x.size_bytes)}
        <Typography component="span" variant="caption" color="text.secondary" ml={0.75}>
          {t('hs_inYear', { size: bytes(x.size_in_365) })}
        </Typography>
      </Fact>
    </Stack>
  );
};

export const ClusterCards: FC<{ fleet: Fleet; onOpen: (id: number) => void }> = ({ fleet, onOpen }) => {
  const { t } = useTranslation('shared');
  const list = fleet.clusters ?? [];
  if (!list.length) return <Typography color="text.secondary">{t('homeNoClusters')}</Typography>;
  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(270px, 1fr))' }}>
      {list.map((c) => {
        const s = c.summary;
        return (
          <Box
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpen(c.id)}
            onKeyDown={(e) => e.key === 'Enter' && onOpen(c.id)}
            sx={{
              p: 2,
              border: 1,
              borderColor: 'divider',
              borderRadius: 2,
              cursor: 'pointer',
              transition: 'border-color .15s, background-color .15s',
              '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
            }}>
            <Stack direction="row" gap={1.5} alignItems="center">
              <Ring score={s?.score} />
              <Box minWidth={0}>
                <Typography fontWeight={700} noWrap>
                  {c.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap display="block">
                  {c.leader ? `${t('hs_leader')} ${c.leader}` : c.status}
                  {s?.version ? ` · PostgreSQL ${s.version}` : ''}
                </Typography>
              </Box>
            </Stack>
            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1, mt: 1.5 }}>
              <Fact label={t('hs_nodes')}>
                <Dot color={c.healthy === c.servers ? 'success.main' : 'error.main'} />
                {c.healthy} / {c.servers}
              </Fact>
              <Fact label={t('hs_data')}>{bytes(s?.size_bytes ?? 0)}</Fact>
              <Fact label={t('hs_inOneYear')}>{s && s.size_in_365 > 0 ? bytes(s.size_in_365) : '—'}</Fact>
            </Box>
            <Typography variant="caption" color="text.secondary" display="block" mt={1.25}>
              {s?.unreachable ? (
                <>
                  <Dot color="error.main" />
                  {t('hs_unreachable')}
                </>
              ) : !s ? (
                t('hs_noData')
              ) : s.critical || s.warning ? (
                <>
                  {s.critical ? (
                    <>
                      <Dot color="error.main" />
                      {t('hs_nCritical', { n: s.critical })}
                      <Box component="span" sx={{ mx: 1 }} />
                    </>
                  ) : null}
                  {s.warning ? (
                    <>
                      <Dot color="warning.main" />
                      {t('hs_nWarning', { n: s.warning })}
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <Dot color="success.main" />
                  {t('hs_allGood')}
                </>
              )}
            </Typography>
          </Box>
        );
      })}
    </Box>
  );
};
