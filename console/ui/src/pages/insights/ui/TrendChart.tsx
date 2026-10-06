import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Stack, Typography, useTheme } from '@mui/material';
import { TPoint } from '@shared/api/api/insights.ts';
import { niceTicks } from '../lib/format.ts';

/** Categorical slots (validated for CVD separation on the console's light and dark surfaces), in fixed order. */
const SLOTS = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

export type ChartSeries = {
  name: string;
  points: TPoint[];
  /** fixed slot per entity (never by rank) */
  slot: number;
  /** projection from the last sample, drawn dashed in the same hue */
  forecast?: TPoint[] | null;
  /** soft area wash under the line (single-series charts) */
  area?: boolean;
};

interface Props {
  series: ChartSeries[];
  format: (v: number) => string;
  /** horizontal limits, e.g. disk size or max_connections */
  limits?: { value: number; label: string }[];
  height?: number;
  yMax?: number;
  empty?: string;
  /** show the legend even for a single series (e.g. which node it is) */
  legend?: boolean;
}

const M = { top: 12, right: 16, bottom: 26, left: 56 };

const fmtDate = (t: number, spanDays: number) =>
  new Date(t).toLocaleString(
    undefined,
    spanDays > 2 ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' },
  );

const TrendChart: FC<Props> = ({ series, format, limits = [], height = 220, yMax, empty, legend }) => {
  const theme = useTheme();
  const dark = theme.palette.mode === 'dark';
  const colors = dark ? SLOTS.dark : SLOTS.light;
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(240, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const data = useMemo(
    () =>
      series.map((s) => ({
        ...s,
        pts: s.points.map((p) => ({ t: new Date(p.t).getTime(), v: p.v })),
        fc: (s.forecast ?? []).map((p) => ({ t: new Date(p.t).getTime(), v: p.v })),
      })),
    [series],
  );
  const all = data.flatMap((s) => [...s.pts, ...s.fc]);
  const hasData = data.some((s) => s.pts.length > 1);

  const tMin = Math.min(...all.map((p) => p.t));
  const tMax = Math.max(...all.map((p) => p.t));
  const vMax = Math.max(yMax ?? 0, ...all.map((p) => p.v), ...limits.map((l) => l.value), 0);
  const ticks = niceTicks(0, vMax || 1, 4);
  const yTop = ticks[ticks.length - 1];
  const iw = width - M.left - M.right;
  const ih = height - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - tMin) / Math.max(1, tMax - tMin)) * iw;
  const y = (v: number) => M.top + ih - (v / yTop) * ih;
  const spanDays = (tMax - tMin) / 86400000;
  const xTicks = Array.from({ length: 5 }, (_, i) => tMin + ((tMax - tMin) * i) / 4);
  const grid = dark ? 'rgba(227,234,245,0.10)' : 'rgba(19,35,63,0.08)';
  const ink = theme.palette.text.secondary;
  const surface = theme.palette.background.paper;

  const path = (pts: { t: number; v: number }[]) =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('');

  // hover: nearest sample of every series to the pointer's time
  const nearest = (pts: { t: number; v: number }[], t: number) => {
    let best: { t: number; v: number } | undefined;
    for (const p of pts) if (!best || Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
    return best;
  };
  const hoverRows =
    hover === null
      ? []
      : data
          .map((s) => {
            const inForecast = s.fc.length > 1 && hover > s.fc[0].t;
            const p = inForecast
              ? {
                  t: hover,
                  v: s.fc[0].v + ((s.fc[1].v - s.fc[0].v) * (hover - s.fc[0].t)) / Math.max(1, s.fc[1].t - s.fc[0].t),
                }
              : nearest(s.pts, hover);
            return p ? { name: s.name, slot: s.slot, v: p.v, t: p.t, forecast: inForecast } : null;
          })
          .filter((r): r is NonNullable<typeof r> => !!r);

  if (!hasData) {
    return (
      <Box
        ref={ref}
        sx={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'text.secondary',
          fontSize: 13,
          textAlign: 'center',
          px: 2,
        }}>
        {empty}
      </Box>
    );
  }

  return (
    <Box ref={ref} sx={{ position: 'relative', userSelect: 'none', width: '100%', minWidth: 0, overflow: 'hidden' }}>
      {legend || series.length > 1 || series.some((s) => s.forecast?.length) ? (
        <Stack direction="row" gap={2} flexWrap="wrap" mb={0.5}>
          {series.map((s) => (
            <Stack key={s.name} direction="row" alignItems="center" gap={0.75}>
              <Box sx={{ width: 14, height: 2, borderRadius: 1, bgcolor: colors[s.slot % 8] }} />
              <Typography variant="caption" color="text.secondary">
                {s.name}
              </Typography>
            </Stack>
          ))}
          {series.some((s) => s.forecast?.length) ? (
            <Stack direction="row" alignItems="center" gap={0.75}>
              <svg width="14" height="2">
                <line x1="0" y1="1" x2="14" y2="1" stroke={ink} strokeWidth="2" strokeDasharray="4 3" />
              </svg>
              <Typography variant="caption" color="text.secondary">
                forecast
              </Typography>
            </Stack>
          ) : null}
        </Stack>
      ) : null}
      <svg
        width={width}
        height={height}
        role="img"
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = e.clientX - r.left;
          if (px < M.left || px > M.left + iw) return setHover(null);
          setHover(tMin + ((px - M.left) / iw) * (tMax - tMin));
        }}
        onPointerLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={M.left} x2={M.left + iw} y1={y(v)} y2={y(v)} stroke={grid} strokeWidth={1} />
            <text x={M.left - 8} y={y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill={ink}>
              {format(v)}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text
            key={t}
            x={x(t)}
            y={height - 6}
            textAnchor={i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}
            fontSize={11}
            fill={ink}>
            {fmtDate(t, spanDays)}
          </text>
        ))}
        {limits.map((l) => (
          <g key={l.label}>
            <line
              x1={M.left}
              x2={M.left + iw}
              y1={y(l.value)}
              y2={y(l.value)}
              stroke={theme.palette.error.main}
              strokeWidth={1}
            />
            <text x={M.left + iw} y={y(l.value) - 5} textAnchor="end" fontSize={11} fill={theme.palette.text.primary}>
              {l.label}
            </text>
          </g>
        ))}
        {data.map((s) => {
          const c = colors[s.slot % 8];
          return (
            <g key={s.name}>
              {s.area && s.pts.length > 1 ? (
                <path
                  d={`${path(s.pts)}L${x(s.pts[s.pts.length - 1].t)},${y(0)}L${x(s.pts[0].t)},${y(0)}Z`}
                  fill={c}
                  opacity={0.1}
                />
              ) : null}
              <path
                d={path(s.pts)}
                fill="none"
                stroke={c}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {s.fc.length > 1 ? (
                <>
                  <path
                    d={path(s.fc)}
                    fill="none"
                    stroke={c}
                    strokeWidth={2}
                    strokeDasharray="5 4"
                    strokeLinecap="round"
                  />
                  <circle cx={x(s.fc[1].t)} cy={y(s.fc[1].v)} r={4} fill={c} stroke={surface} strokeWidth={2} />
                </>
              ) : null}
            </g>
          );
        })}
        {hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={M.top} y2={M.top + ih} stroke={ink} strokeWidth={1} opacity={0.5} />
            {hoverRows.map((r) => (
              <circle
                key={r.name}
                cx={x(r.forecast ? hover : r.t)}
                cy={y(r.v)}
                r={4}
                fill={colors[r.slot % 8]}
                stroke={surface}
                strokeWidth={2}
              />
            ))}
          </g>
        ) : null}
        <rect x={M.left} y={M.top} width={iw} height={ih} fill="transparent" />
      </svg>
      {hover !== null && hoverRows.length ? (
        <Box
          sx={{
            position: 'absolute',
            top: 28,
            left: Math.min(Math.max(x(hover) + 12, 0), width - 200),
            pointerEvents: 'none',
            bgcolor: 'background.paper',
            border: 1,
            borderColor: 'divider',
            borderRadius: 1.5,
            boxShadow: 3,
            px: 1.25,
            py: 0.75,
            minWidth: 150,
          }}>
          <Typography variant="caption" color="text.secondary" component="div">
            {new Date(hover).toLocaleString(undefined, {
              day: 'numeric',
              month: 'short',
              hour: '2-digit',
              minute: '2-digit',
            })}
            {hoverRows.some((r) => r.forecast) ? ' · forecast' : ''}
          </Typography>
          {hoverRows.map((r) => (
            <Stack key={r.name} direction="row" alignItems="center" gap={1}>
              <Box sx={{ width: 10, height: 2, bgcolor: colors[r.slot % 8], borderRadius: 1 }} />
              <Typography variant="body2" fontWeight={700}>
                {format(r.v)}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {r.name}
              </Typography>
            </Stack>
          ))}
        </Box>
      ) : null}
    </Box>
  );
};

export default TrendChart;
