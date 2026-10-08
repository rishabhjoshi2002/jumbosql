/** Number formatting for the Insights page. */

export const bytes = (b?: number | null, digits = 1) => {
  if (b === undefined || b === null || !Number.isFinite(b)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(b);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${b < 0 ? '-' : ''}${i === 0 ? v.toFixed(0) : v.toFixed(digits)} ${units[i]}`;
};

export const compact = (n?: number | null, digits = 1) => {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (Number.isInteger(n) && a < 1e4) return String(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(digits)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(digits)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(digits)}K`;
  if (a >= 100) return n.toFixed(0);
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2).replace(/\.?0+$/, '') || '0';
};

export const pct = (n?: number | null, digits = 0) =>
  n === undefined || n === null || !Number.isFinite(n) ? '—' : `${n.toFixed(digits)}%`;

/** a CPU forecast past 100 % means "more than the node has" */
export const cpuPct = (n: number) => (n > 100 ? '> 100%' : pct(n));

export const signed = (s: string, n: number) => (n > 0 ? `+${s}` : s);

export const ms = (n: number) =>
  n >= 60000 ? `${(n / 60000).toFixed(1)} min` : n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n.toFixed(1)} ms`;

/** "in 12 days" / "not growing" for a days-until value (-1 = never) */
export const daysText = (d: number) => (d < 0 ? null : d < 1 ? '< 1 day' : `${Math.round(d)} days`);

/** nice axis ticks: about `count` round numbers covering [min, max] */
export const niceTicks = (min: number, max: number, count = 4) => {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (max === min) max = min + 1;
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(min / step) * step;
  const out: number[] = [];
  // until a tick reaches the maximum, so the top gridline is always above the highest value
  for (let v = start; out.length < 50; v += step) {
    out.push(Number(v.toPrecision(12)));
    if (v >= max) break;
  }
  return out;
};

/** vCPUs that keep the busy-hour CPU near 65 % (same rule as the server's recommendation) */
export const suggestedCores = (cores: number, p95: number, forecast: number) => {
  const next = Math.max(p95, forecast);
  if (!cores || next < 75) return cores;
  return Math.max(cores, Math.ceil((cores * next) / 65));
};

/** a value in a capacity item's unit */
export const unitValue = (v: number | undefined | null, unit: string) => {
  if (v === undefined || v === null || !Number.isFinite(v)) return '—';
  switch (unit) {
    case 'bytes':
      return bytes(v);
    case 'pct':
      return pct(v);
    case 'per_sec':
      return `${compact(v)}/s`;
    default:
      return compact(Math.round(v));
  }
};

/** "30 days", "3 months", "1 year" for a horizon */
export const horizonLabel = (d: number) =>
  d >= 360
    ? `${Math.round(d / 365)} year${d >= 700 ? 's' : ''}`
    : d >= 85
      ? `${Math.round(d / 30)} months`
      : `${d} days`;

/** short date, e.g. "12 Mar 2027" */
export const shortDate = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/** health score colour */
export const scoreColor = (score: number) => (score >= 85 ? 'success' : score >= 60 ? 'warning' : 'error');

/** "+12.5%" growth per month; very fast growth (tiny starting point) reads "> +999%" */
export const growthPct = (n: number) =>
  n >= 1000 ? '> +999%' : `${n > 0 ? '+' : ''}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
