import { FC, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useTranslation } from 'react-i18next';
import { CapacityItem, InsightsReport } from '@shared/api/api/insights.ts';
import { Card } from './parts.tsx';
import TrendChart from './TrendChart.tsx';
import { daysText, growthPct, horizonLabel, shortDate, unitValue } from '../lib/format.ts';

const STATUS_COLOR = { act: 'error', watch: 'warning', ok: 'success' } as const;

const needText = (c: CapacityItem) => {
  if (!c.need_unit || !c.need_now) return '';
  const v = (n?: number) => (c.need_unit === 'bytes' ? unitValue(n, 'bytes') : `${n ?? '—'} vCPU`);
  return c.need_at_horizon && c.need_at_horizon !== c.need_now
    ? `${v(c.need_now)} → ${v(c.need_at_horizon)}`
    : v(c.need_now);
};

/** "in 45 days (12 Mar 2027)", or "not in sight" */
const whenText = (days: number, date: string | undefined, notInSight: string, already: string) =>
  days < 0 ? notInSight : days === 0 ? already : `${daysText(days)} · ${shortDate(date)}`;

/** Capacity planning: every resource with where it is heading, when it hits its warning level and its limit. */
const Capacity: FC<{ rep: InsightsReport }> = ({ rep }) => {
  const { t } = useTranslation('insights');
  const items = rep.capacity ?? [];
  const [key, setKey] = useState<string>('');
  const sel = items.find((c) => c.key === key) ?? items[0];
  const h = rep.horizon || 30;

  if (!items.length) return <Alert severity="info">{t('capacityEmpty')}</Alert>;

  const f = sel?.forecast;
  const atHorizon = f?.band?.length ? f.band[f.band.length - 1] : null;

  return (
    <Stack gap={2}>
      <Card title={t('capacityTitle', { horizon: horizonLabel(h) })} subtitle={t('capacityHelp')}>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t('status')}</TableCell>
                <TableCell>{t('resource')}</TableCell>
                <TableCell align="right">{t('today')}</TableCell>
                <TableCell align="right">{t('inHorizon', { horizon: horizonLabel(h) })}</TableCell>
                <TableCell align="right">{t('growthPerMonth')}</TableCell>
                <TableCell>{t('reachesWarning')}</TableCell>
                <TableCell>{t('reachesLimit')}</TableCell>
                <TableCell>{t('needed')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((c) => {
                const end = c.forecast.band?.length ? c.forecast.band[c.forecast.band.length - 1] : null;
                return (
                  <TableRow
                    key={c.key}
                    hover
                    selected={c.key === sel?.key}
                    onClick={() => setKey(c.key)}
                    sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[c.status]}
                        variant={c.status === 'ok' ? 'outlined' : 'filled'}
                        label={t(`status_${c.status}`)}
                        sx={{ height: 20 }}
                      />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>
                        {c.title}
                      </Typography>
                      {c.limit ? (
                        <Typography variant="caption" color="text.secondary">
                          {t('limitIs', { value: unitValue(c.limit, c.unit) })}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell align="right">{unitValue(c.now, c.unit)}</TableCell>
                    <TableCell align="right">
                      {c.forecast.has_forecast && end ? (
                        <>
                          <Typography variant="body2" fontWeight={600}>
                            {unitValue(end.v, c.unit)}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {unitValue(Math.max(0, end.low), c.unit)} – {unitValue(end.high, c.unit)}
                          </Typography>
                        </>
                      ) : (
                        <Typography variant="caption" color="text.secondary">
                          {t('collecting')}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell align="right">
                      {c.forecast.has_forecast ? growthPct(c.forecast.growth_pct_month) : '—'}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {c.warn_at ? whenText(c.warn_in_days, c.warn_date, t('notInSight'), t('alreadyThere')) : '—'}
                    </TableCell>
                    <TableCell
                      sx={{
                        whiteSpace: 'nowrap',
                        color: c.limit_in_days >= 0 && c.limit_in_days <= h ? 'error.main' : undefined,
                        fontWeight: c.limit_in_days >= 0 && c.limit_in_days <= h ? 700 : undefined,
                      }}>
                      {c.limit ? whenText(c.limit_in_days, c.limit_date, t('notInSight'), t('alreadyThere')) : '—'}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{needText(c) || '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {sel && f ? (
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 2fr) minmax(0, 1fr)' },
          }}>
          <Card
            title={sel.title}
            subtitle={
              f.has_forecast
                ? t('modelLine', {
                    model: t(`model_${f.model || 'linear'}`),
                    growth: growthPct(f.growth_pct_month),
                    r2: f.r2.toFixed(2),
                    span: Math.max(1, Math.round(f.span_days)),
                    confidence: t(`conf_${f.confidence}`),
                  })
                : t('collecting')
            }>
            <TrendChart
              series={[{ name: sel.title, points: sel.history ?? [], slot: 0, band: f.band, area: true }]}
              limits={[
                ...(sel.limit
                  ? [{ value: sel.limit, label: t('limitIs', { value: unitValue(sel.limit, sel.unit) }) }]
                  : []),
                ...(sel.warn_at && sel.warn_at !== sel.limit
                  ? [
                      {
                        value: sel.warn_at,
                        label: t('warnIs', { value: unitValue(sel.warn_at, sel.unit) }),
                        tone: 'warning' as const,
                      },
                    ]
                  : []),
              ]}
              format={(v) => unitValue(v, sel.unit)}
              height={280}
              empty={t('collecting')}
            />
            {sel.advice ? (
              <Alert
                severity={sel.status === 'act' ? 'error' : sel.status === 'watch' ? 'warning' : 'success'}
                sx={{ mt: 1.5 }}>
                {sel.advice}
              </Alert>
            ) : null}
          </Card>
          <Card title={t('milestones')} subtitle={t('milestonesHelp')}>
            {f.has_forecast && f.projections?.length ? (
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>{t('ahead')}</TableCell>
                    <TableCell align="right">{t('expected')}</TableCell>
                    <TableCell align="right">{t('likelyRange')}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {f.projections.map((p) => (
                    <TableRow key={p.days} sx={{ opacity: p.reliable ? 1 : 0.6 }}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>
                          {horizonLabel(p.days)}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {shortDate(p.at)}
                          {p.reliable ? '' : ` · ${t('rough')}`}
                        </Typography>
                      </TableCell>
                      <TableCell
                        align="right"
                        sx={{
                          fontWeight: 600,
                          color:
                            sel.limit && p.v >= sel.limit
                              ? 'error.main'
                              : sel.warn_at && p.v >= sel.warn_at
                                ? 'warning.main'
                                : undefined,
                        }}>
                        {unitValue(p.v, sel.unit)}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                        {unitValue(Math.max(0, p.low), sel.unit)} – {unitValue(p.high, sel.unit)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Typography variant="body2" color="text.secondary">
                {t('collecting')}
              </Typography>
            )}
            {atHorizon && sel.unit === 'pct' && atHorizon.v > 100 ? (
              <Typography variant="caption" color="text.secondary" component="div" mt={1}>
                {t('over100')}
              </Typography>
            ) : null}
          </Card>
        </Box>
      ) : null}

      <Card title={t('howTitle')}>
        <Stack component="ul" gap={0.5} sx={{ m: 0, pl: 2.5 }}>
          {(t('howLines', { returnObjects: true }) as string[]).map((l) => (
            <Typography component="li" variant="body2" key={l}>
              {l}
            </Typography>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
};

export default Capacity;
