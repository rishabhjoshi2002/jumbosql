import { FC, ReactNode, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { InsightsReport, InsightsTable, Recommendation } from '@shared/api/api/insights.ts';
import { bytes, compact, pct, scoreColor, signed } from '../lib/format.ts';

/** JumboSQL Insights: building blocks shared by the tabs (cards, tiles, recommendations, tables). */

export const Card: FC<{ title: string; subtitle?: ReactNode; children: ReactNode; action?: ReactNode }> = ({
  title,
  subtitle,
  children,
  action,
}) => (
  <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 2, p: 2, bgcolor: 'background.paper', minWidth: 0 }}>
    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" gap={1} mb={1}>
      <Box>
        <Typography fontWeight={700}>{title}</Typography>
        {subtitle ? (
          <Typography variant="caption" color="text.secondary" component="div">
            {subtitle}
          </Typography>
        ) : null}
      </Box>
      {action}
    </Stack>
    {children}
  </Box>
);

export const Stat: FC<{ label: string; value: string; sub?: ReactNode; tone?: 'critical' | 'warning' }> = ({
  label,
  value,
  sub,
  tone,
}) => (
  <Box
    sx={{
      border: 1,
      borderColor: tone === 'critical' ? 'error.main' : tone === 'warning' ? 'warning.main' : 'divider',
      borderRadius: 2,
      p: 2,
      bgcolor: 'background.paper',
      minWidth: 0,
    }}>
    <Typography variant="body2" color="text.secondary" noWrap>
      {label}
    </Typography>
    <Typography sx={{ fontSize: 28, fontWeight: 650, lineHeight: 1.25, my: 0.25 }} noWrap>
      {value}
    </Typography>
    <Typography variant="caption" color="text.secondary" component="div" sx={{ minHeight: 18 }}>
      {sub}
    </Typography>
  </Box>
);

export const SEVERITY: Record<Recommendation['severity'], { icon: ReactNode; color: 'error' | 'warning' | 'info' }> = {
  critical: { icon: <ErrorOutlineIcon fontSize="small" color="error" />, color: 'error' },
  warning: { icon: <WarningAmberIcon fontSize="small" color="warning" />, color: 'warning' },
  info: { icon: <InfoOutlinedIcon fontSize="small" color="info" />, color: 'info' },
};

export const Recommendations: FC<{ items: Recommendation[] }> = ({ items }) => {
  const { t } = useTranslation('insights');
  const [filter, setFilter] = useState<string>('all');
  const counts = useMemo(() => {
    const c: Record<string, number> = { critical: 0, warning: 0, info: 0 };
    items.forEach((r) => (c[r.severity] += 1));
    return c;
  }, [items]);
  const shown = items.filter((r) => filter === 'all' || r.severity === filter);
  return (
    <Card
      title={t('recommendations')}
      subtitle={t('recommendationsHelp')}
      action={
        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_, v) => v && setFilter(v)}>
          <ToggleButton value="all">{t('all')}</ToggleButton>
          <ToggleButton value="critical">
            {t('critical')} ({counts.critical})
          </ToggleButton>
          <ToggleButton value="warning">
            {t('warning')} ({counts.warning})
          </ToggleButton>
          <ToggleButton value="info">
            {t('info')} ({counts.info})
          </ToggleButton>
        </ToggleButtonGroup>
      }>
      {!items.length ? (
        <Alert severity="success">{t('noRecommendations')}</Alert>
      ) : (
        <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
          {shown.map((r, i) => {
            const s = SEVERITY[r.severity];
            return (
              <Stack key={i} direction="row" gap={1.5} py={1.25}>
                <Box sx={{ color: `${s.color}.main`, pt: '2px' }}>{s.icon}</Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" gap={1} alignItems="center" flexWrap="wrap">
                    <Typography fontWeight={700}>{r.title}</Typography>
                    <Chip size="small" variant="outlined" color={s.color} label={t(r.severity)} sx={{ height: 20 }} />
                    <Chip
                      size="small"
                      variant="outlined"
                      label={t(`cat_${r.category}`, { defaultValue: r.category })}
                      sx={{ height: 20 }}
                    />
                  </Stack>
                  <Typography variant="body2" color="text.secondary" mt={0.25}>
                    {r.detail}
                  </Typography>
                  {r.action ? (
                    <Typography variant="body2" mt={0.5}>
                      <b>{t('whatToDo')}:</b> {r.action}
                    </Typography>
                  ) : null}
                  {r.sql ? (
                    <Box sx={{ position: 'relative', mt: 0.75 }}>
                      <Box
                        component="pre"
                        sx={{
                          m: 0,
                          p: 1.25,
                          pr: 5,
                          borderRadius: 1,
                          bgcolor: 'action.hover',
                          fontFamily: '"JetBrains Mono", monospace',
                          fontSize: 12,
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}>
                        {r.sql}
                      </Box>
                      <Tooltip title={t('copySql')}>
                        <IconButton
                          size="small"
                          sx={{ position: 'absolute', top: 4, right: 4 }}
                          onClick={() => {
                            void navigator.clipboard?.writeText(r.sql ?? '');
                            toast.success(t('copied'));
                          }}>
                          <ContentCopyIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </Box>
                  ) : null}
                </Box>
              </Stack>
            );
          })}
        </Stack>
      )}
    </Card>
  );
};

type SortKey = 'total_bytes' | 'dead_pct' | 'bloat_bytes' | 'growth_bytes_per_day' | 'seq_scans';

export const TablesCard: FC<{ rep: InsightsReport; database: string; onDatabase: (d: string) => void }> = ({
  rep,
  database,
  onDatabase,
}) => {
  const { t } = useTranslation('insights');
  const [sort, setSort] = useState<SortKey>('total_bytes');
  const items = useMemo(
    () => [...(rep.tables.items ?? [])].sort((a: InsightsTable, b: InsightsTable) => (b[sort] ?? 0) - (a[sort] ?? 0)),
    [rep.tables.items, sort],
  );
  const head = (key: SortKey, label: string) => (
    <TableCell align="right">
      <TableSortLabel active={sort === key} direction="desc" onClick={() => setSort(key)}>
        {label}
      </TableSortLabel>
    </TableCell>
  );
  return (
    <Card
      title={t('tables')}
      subtitle={t('tablesHelp')}
      action={
        <TextField
          select
          size="small"
          label={t('database')}
          value={rep.tables.database}
          onChange={(e) => onDatabase(e.target.value)}
          sx={{ minWidth: 180 }}>
          {(rep.tables.databases ?? [database]).map((d) => (
            <MenuItem key={d} value={d}>
              {d}
            </MenuItem>
          ))}
        </TextField>
      }>
      {rep.tables.error ? <Alert severity="warning">{rep.tables.error}</Alert> : null}
      <TableContainer sx={{ maxHeight: 520 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              <TableCell>{t('table')}</TableCell>
              {head('total_bytes', t('size'))}
              <TableCell align="right">{t('rows')}</TableCell>
              {head('dead_pct', t('deadRows'))}
              {head('bloat_bytes', t('wasted'))}
              {head('growth_bytes_per_day', t('growthPerDay'))}
              <TableCell align="right">{t('in30Days')}</TableCell>
              {head('seq_scans', t('scans'))}
              <TableCell>{t('lastVacuum')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((x) => (
              <TableRow key={x.name} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{x.name}</TableCell>
                <TableCell align="right">{bytes(x.total_bytes)}</TableCell>
                <TableCell align="right">{compact(x.live_rows)}</TableCell>
                <TableCell align="right">
                  <Stack direction="row" gap={0.75} alignItems="center" justifyContent="flex-end">
                    {x.dead_pct >= 20 && x.dead_rows >= 10000 ? (
                      <WarningAmberIcon color="warning" sx={{ fontSize: 16 }} />
                    ) : null}
                    {pct(x.dead_pct)}
                  </Stack>
                </TableCell>
                <TableCell align="right">{x.bloat_bytes ? bytes(x.bloat_bytes) : '—'}</TableCell>
                <TableCell align="right">
                  {x.has_trend ? signed(bytes(x.growth_bytes_per_day), x.growth_bytes_per_day) : '—'}
                </TableCell>
                <TableCell align="right">{x.has_trend ? bytes(x.in_30_days) : '—'}</TableCell>
                <TableCell align="right">
                  <Tooltip title={t('scansHelp', { seq: compact(x.seq_scans), idx: compact(x.idx_scans) })}>
                    <span>
                      {compact(x.seq_scans)} / {compact(x.idx_scans)}
                    </span>
                  </Tooltip>
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap', color: 'text.secondary' }}>
                  {x.last_vacuum ? new Date(x.last_vacuum).toLocaleDateString() : t('never')}
                </TableCell>
              </TableRow>
            ))}
            {!items.length ? (
              <TableRow>
                <TableCell colSpan={9} align="center" sx={{ color: 'text.secondary', py: 3 }}>
                  {t('noTables')}
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>
      {rep.unused_indexes?.length ? (
        <Box mt={2}>
          <Typography variant="body2" fontWeight={700} mb={0.5}>
            {t('unusedIndexes')}
          </Typography>
          <Stack direction="row" gap={0.75} flexWrap="wrap">
            {rep.unused_indexes.map((i) => (
              <Chip
                key={i.name}
                size="small"
                variant="outlined"
                label={`${i.name} · ${bytes(i.bytes)}`}
                sx={{ fontFamily: 'monospace' }}
              />
            ))}
          </Stack>
        </Box>
      ) : null}
    </Card>
  );
};

export const forecastText = (
  f: { has_forecast: boolean; in_30_days: number; confidence: string },
  fmt: (v: number) => string,
  t: TFunction<'insights'>,
) =>
  f.has_forecast
    ? t('in30DaysValue', { value: fmt(f.in_30_days), confidence: t(`conf_${f.confidence}`) })
    : t('collecting');

/** health score 0..100 as a ring */
export const ScoreRing: FC<{ score: number; size?: number; label?: string }> = ({ score, size = 112, label }) => {
  const theme = useTheme();
  const color = theme.palette[scoreColor(score)].main;
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  return (
    <Box sx={{ position: 'relative', width: size, height: size, flex: 'none' }}>
      <svg width={size} height={size} role="img" aria-label={`${score} / 100`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={theme.palette.action.hover} strokeWidth={9} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          strokeDasharray={`${(c * Math.max(0, Math.min(100, score))) / 100} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <Stack sx={{ position: 'absolute', inset: 0 }} alignItems="center" justifyContent="center">
        <Typography sx={{ fontSize: size / 3.6, fontWeight: 700, lineHeight: 1 }}>{score}</Typography>
        {label ? (
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
};

/** small coloured score chip, e.g. "72 · fair" */
export const ScoreChip: FC<{ score: number; grade?: string }> = ({ score, grade }) => (
  <Chip
    size="small"
    color={scoreColor(score)}
    variant="outlined"
    label={grade ? `${score} · ${grade}` : String(score)}
    sx={{ fontWeight: 700, height: 22 }}
  />
);

export const OUTLOOK_ICON: Record<string, ReactNode> = {
  critical: <ErrorOutlineIcon fontSize="small" color="error" />,
  warning: <WarningAmberIcon fontSize="small" color="warning" />,
  info: <InfoOutlinedIcon fontSize="small" color="info" />,
  ok: <CheckCircleOutlineIcon fontSize="small" color="success" />,
};
