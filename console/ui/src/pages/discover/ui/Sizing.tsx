import { FC, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  InputAdornment,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { DHostSizing, DResult, DSize } from '@shared/api/api/discover.ts';
import { bytes, pct } from '@pages/insights/lib/format.ts';
import TrendChart from '@pages/insights/ui/TrendChart.tsx';
import type { BandPoint } from '@shared/api/api/insights.ts';
import Card from './Card.tsx';

const GB = 1024 ** 3;
const mono = { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 };

type Rates = { currency: string; cpu: number; ram: number; disk: number };
// rough public-cloud list prices per month (editable)
const DEFAULT_RATES: Rates = { currency: 'USD', cpu: 20, ram: 3.75, disk: 0.08 };
const RATES_KEY = 'pg_genie.discover.rates';

const loadRates = (): Rates => {
  try {
    const r = JSON.parse(localStorage.getItem(RATES_KEY) ?? 'null');
    return r && typeof r.cpu === 'number' ? { ...DEFAULT_RATES, ...r } : DEFAULT_RATES;
  } catch {
    return DEFAULT_RATES;
  }
};

const cost = (s: DSize, r: Rates) => s.cpus * r.cpu + (s.mem_bytes / GB) * r.ram + (s.disk_bytes / GB) * r.disk;

// percentages never go above 100 (the forecast line can)
const capPct = (b?: BandPoint[] | null) =>
  b?.map((p) => ({ ...p, v: Math.min(100, p.v), low: Math.min(100, p.low), high: Math.min(100, p.high) })) ?? null;

const STATUS_COLOR = { under: 'error', over: 'warning', right: 'success', unknown: 'default' } as const;

const sizeText = (s: DSize) =>
  [
    s.cpus ? `${s.cpus} vCPU` : null,
    s.mem_bytes ? bytes(s.mem_bytes, 0) : null,
    s.disk_bytes ? bytes(s.disk_bytes, 0) : null,
  ]
    .filter(Boolean)
    .join(' · ') || '—';

/** Sizing & cost: what each machine needs (from its usage history), what it costs, and PostgreSQL settings. */
const Sizing: FC<{ result: DResult }> = ({ result }) => {
  const { t } = useTranslation('discover');
  const sz = result.sizing!;
  const [rates, setRates] = useState<Rates>(loadRates);
  const [sel, setSel] = useState(sz.hosts.find((h) => h.trend)?.address ?? sz.hosts[0]?.address ?? '');
  const host = sz.hosts.find((h) => h.address === sel);

  useEffect(() => {
    try {
      localStorage.setItem(RATES_KEY, JSON.stringify(rates));
    } catch {
      /* private window: keep in memory */
    }
  }, [rates]);

  const money = useMemo(() => {
    const f = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: rates.currency,
      maximumFractionDigits: 0,
    });
    return (v: number) => f.format(v);
  }, [rates.currency]);

  const known = sz.hosts.filter((h) => h.current.cpus > 0 && h.current.mem_bytes > 0);
  const nowMonth = known.reduce((s, h) => s + cost(h.current, rates), 0);
  const recMonth = known.reduce((s, h) => s + cost(h.recommended, rates), 0);
  const allRec = sz.hosts.reduce((s, h) => s + cost(h.recommended, rates), 0);
  const diff = recMonth - nowMonth;

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => toast.success(t('copied')),
      () => toast.error(t('copyFailed')),
    );
  };
  const rate = (k: keyof Omit<Rates, 'currency'>, label: string, unit: string) => (
    <TextField
      size="small"
      type="number"
      label={label}
      value={rates[k]}
      onChange={(e) => setRates((r) => ({ ...r, [k]: Math.max(0, Number(e.target.value) || 0) }))}
      InputProps={{ endAdornment: <InputAdornment position="end">{unit}</InputAdornment> }}
      inputProps={{ step: k === 'disk' ? 0.01 : 0.25, min: 0 }}
      sx={{ width: 190 }}
    />
  );

  return (
    <Stack gap={2}>
      {sz.source === 'prometheus' ? (
        <Alert severity="success">{t('sizingFromProm', { url: sz.prometheus, days: sz.days })}</Alert>
      ) : (
        <Alert severity="info" title={sz.error}>
          {t('sizingNoProm')}
          {sz.error ? ` (${sz.error})` : ''}
        </Alert>
      )}

      <Card title={t('costTitle')}>
        <Stack direction="row" gap={1.5} flexWrap="wrap" mb={2}>
          <TextField
            select
            size="small"
            label={t('currency')}
            value={rates.currency}
            onChange={(e) => setRates((r) => ({ ...r, currency: e.target.value }))}
            sx={{ width: 110 }}>
            {['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'JPY'].map((c) => (
              <MenuItem key={c} value={c}>
                {c}
              </MenuItem>
            ))}
          </TextField>
          {rate('cpu', t('perVcpu'), t('perMonth'))}
          {rate('ram', t('perGbRam'), t('perMonth'))}
          {rate('disk', t('perGbDisk'), t('perMonth'))}
          <Button size="small" onClick={() => setRates(DEFAULT_RATES)}>
            {t('resetRates')}
          </Button>
        </Stack>
        <Box
          sx={{
            display: 'grid',
            gap: 1.5,
            mb: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          }}>
          {[
            [t('k_costNow'), known.length ? money(nowMonth) : '—', t('k_perMonthYear', { year: money(nowMonth * 12) })],
            [
              t('k_costRec'),
              money(known.length ? recMonth : allRec),
              t('k_perMonthYear', { year: money((known.length ? recMonth : allRec) * 12) }),
            ],
            [
              diff > 0 ? t('k_extra') : t('k_saving'),
              known.length ? money(Math.abs(diff)) : '—',
              known.length ? t('k_perMonthYear', { year: money(Math.abs(diff) * 12) }) : t('k_needHw'),
            ],
            [
              t('k_machines'),
              String(sz.hosts.length),
              t('k_statusLine', {
                under: sz.hosts.filter((h) => h.status === 'under').length,
                over: sz.hosts.filter((h) => h.status === 'over').length,
              }),
            ],
          ].map(([label, value, sub]) => (
            <Box key={label} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, px: 1.5, py: 1 }}>
              <Typography variant="caption" color="text.secondary">
                {label}
              </Typography>
              <Typography sx={{ fontSize: 22, fontWeight: 700, lineHeight: 1.3 }}>{value}</Typography>
              <Typography variant="caption" color="text.secondary">
                {sub}
              </Typography>
            </Box>
          ))}
        </Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                <TableCell>{t('c_machine')}</TableCell>
                <TableCell>{t('c_hwNow')}</TableCell>
                <TableCell align="right">{t('c_peak')}</TableCell>
                <TableCell>{t('c_hwRec')}</TableCell>
                <TableCell>{t('c_status')}</TableCell>
                <TableCell align="right">{t('c_cost')}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sz.hosts.map((h: DHostSizing) => {
                const hasNow = h.current.cpus > 0 && h.current.mem_bytes > 0;
                return (
                  <TableRow
                    key={h.address}
                    hover
                    selected={h.address === sel}
                    onClick={() => setSel(h.address)}
                    sx={{ cursor: 'pointer' }}>
                    <TableCell>
                      <Typography variant="body2" fontWeight={700}>
                        {h.name}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={mono}>
                        {h.address}
                      </Typography>
                      {h.pg_role ? (
                        <Typography variant="caption" color="text.secondary">
                          {' '}
                          · {t(`role_${h.pg_role}`)}
                        </Typography>
                      ) : null}
                    </TableCell>
                    <TableCell>{hasNow ? sizeText(h.current) : t('unknownHw')}</TableCell>
                    <TableCell align="right">
                      {h.cpu_peak_pct >= 0 ? `${pct(h.cpu_peak_pct)} / ${pct(h.mem_peak_pct)}` : '—'}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{sizeText(h.recommended)}</TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={STATUS_COLOR[h.status]}
                        label={t(`st_${h.status}`)}
                        sx={{ fontWeight: 700 }}
                      />
                    </TableCell>
                    <TableCell align="right">
                      {hasNow ? `${money(cost(h.current, rates))} → ` : ''}
                      <b>{money(cost(h.recommended, rates))}</b>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {host ? (
        <Card
          title={t('whyTitle', { host: host.name })}
          action={
            <Chip
              size="small"
              color={STATUS_COLOR[host.status]}
              label={t(`st_${host.status}`)}
              sx={{ fontWeight: 700 }}
            />
          }>
          <TableContainer sx={{ mb: 2 }}>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                  <TableCell />
                  <TableCell>{t('w_has')}</TableCell>
                  <TableCell>{t('w_peak')}</TableCell>
                  <TableCell>{t('w_ahead', { days: sz.horizon })}</TableCell>
                  <TableCell>{t('w_need')}</TableCell>
                  <TableCell>{t('w_how')}</TableCell>
                  <TableCell align="right">{t('w_cost')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(host.lines ?? []).map((l) => {
                  const key = l.resource as 'cpu' | 'ram' | 'disk';
                  const unit = { cpu: rates.cpu, ram: rates.ram, disk: rates.disk }[key];
                  const has = {
                    cpu: host.current.cpus,
                    ram: host.current.mem_bytes / GB,
                    disk: host.current.disk_bytes / GB,
                  }[key];
                  const need = {
                    cpu: host.recommended.cpus,
                    ram: host.recommended.mem_bytes / GB,
                    disk: host.recommended.disk_bytes / GB,
                  }[key];
                  return (
                    <TableRow key={l.resource} sx={{ '& td': { whiteSpace: 'nowrap' } }}>
                      <TableCell sx={{ fontWeight: 700 }}>{t(`r_${l.resource}`)}</TableCell>
                      <TableCell>{l.has}</TableCell>
                      <TableCell>{l.peak}</TableCell>
                      <TableCell>{l.ahead}</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>{l.need}</TableCell>
                      <TableCell sx={{ ...mono, whiteSpace: 'normal !important' }}>{l.how}</TableCell>
                      <TableCell align="right">
                        {has ? `${money(has * unit)} → ` : ''}
                        <b>{money(need * unit)}</b>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          {host.reasons.map((r) => (
            <Typography variant="body2" color="text.secondary" key={r} mb={1}>
              {r}
            </Typography>
          ))}
          {host.trend ? (
            <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', xl: 'repeat(3, 1fr)' } }}>
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('chartCpu', { cores: host.trend.cores })}
                </Typography>
                <TrendChart
                  series={[
                    {
                      name: 'CPU',
                      points: host.trend.cpu ?? [],
                      slot: 0,
                      band: capPct(host.trend.cpu_forecast.band),
                      area: true,
                    },
                  ]}
                  format={(v) => pct(v)}
                  yMax={100}
                  limits={[{ value: 65, label: t('target65'), tone: 'warning' }]}
                  height={200}
                />
              </Box>
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('chartMem', { total: bytes(host.trend.mem_total_bytes) })}
                </Typography>
                <TrendChart
                  series={[
                    {
                      name: 'RAM',
                      points: host.trend.mem ?? [],
                      slot: 1,
                      band: capPct(host.trend.mem_forecast.band),
                      area: true,
                    },
                  ]}
                  format={(v) => pct(v)}
                  yMax={100}
                  limits={[{ value: 80, label: t('target80'), tone: 'warning' }]}
                  height={200}
                />
              </Box>
              <Box>
                <Typography variant="body2" fontWeight={700} mb={0.5}>
                  {t('chartDisk', { mount: host.trend.mount ?? '/' })}
                </Typography>
                <TrendChart
                  series={[
                    {
                      name: 'Disk',
                      points: host.trend.disk_used ?? [],
                      slot: 2,
                      band: host.trend.disk_forecast.band,
                      area: true,
                    },
                  ]}
                  format={(v) => bytes(v)}
                  limits={
                    host.trend.disk_size_bytes ? [{ value: host.trend.disk_size_bytes, label: t('diskSize') }] : []
                  }
                  height={200}
                />
              </Box>
            </Box>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {t('noTrend')}
            </Typography>
          )}
        </Card>
      ) : null}

      <Card title={t('tuneTitle')}>
        <Stack gap={2}>
          {sz.tuning.map((tu) => {
            const node = result.nodes.find((n) => n.id === tu.node);
            return (
              <Box key={tu.node} sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
                <Stack direction="row" gap={1} alignItems="baseline" flexWrap="wrap" mb={1}>
                  <Typography fontWeight={700}>{node?.name ?? tu.node}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t(`role_${tu.role}`)} · {tu.node} ·{' '}
                    {t('tunedFor', { cpus: tu.for.cpus, ram: bytes(tu.for.mem_bytes) })}
                  </Typography>
                </Stack>
                {tu.changes.length ? (
                  <>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow sx={{ '& th': { whiteSpace: 'nowrap' } }}>
                            <TableCell>{t('c_setting')}</TableCell>
                            <TableCell>{t('c_current')}</TableCell>
                            <TableCell>{t('c_recommended')}</TableCell>
                            <TableCell>{t('c_restart')}</TableCell>
                            <TableCell>{t('c_why')}</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {tu.changes.map((c) => (
                            <TableRow key={c.name}>
                              <TableCell sx={mono}>{c.name}</TableCell>
                              <TableCell sx={mono}>{c.current}</TableCell>
                              <TableCell sx={{ ...mono, fontWeight: 700 }}>{c.recommended}</TableCell>
                              <TableCell>{c.restart ? t('yes') : ''}</TableCell>
                              <TableCell>
                                <Typography variant="body2" color="text.secondary">
                                  {c.reason}
                                </Typography>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                    <Box sx={{ position: 'relative', mt: 1.5 }}>
                      <Box
                        component="pre"
                        sx={{
                          ...mono,
                          m: 0,
                          p: 1.5,
                          pr: 6,
                          bgcolor: 'action.hover',
                          borderRadius: 1.5,
                          overflowX: 'auto',
                          whiteSpace: 'pre',
                        }}>
                        {tu.script}
                      </Box>
                      <Button
                        size="small"
                        startIcon={<ContentCopyIcon fontSize="small" />}
                        onClick={() => copy(tu.script)}
                        sx={{ position: 'absolute', top: 6, right: 6 }}>
                        {t('copy')}
                      </Button>
                    </Box>
                  </>
                ) : (
                  <Typography variant="body2" color="success.main">
                    {t('tuneOk')}
                  </Typography>
                )}
              </Box>
            );
          })}
          {!sz.tuning.length ? (
            <Typography variant="body2" color="text.secondary">
              {t('tuneNone')}
            </Typography>
          ) : null}
        </Stack>
      </Card>
    </Stack>
  );
};

export default Sizing;
