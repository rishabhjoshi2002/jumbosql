import { FC, useMemo, useState } from 'react';
import { Box, Stack, Typography, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { DNode, DResult } from '@shared/api/api/discover.ts';
import { bytes } from '@pages/insights/lib/format.ts';
import { BOX, layout } from '../lib/layout.ts';

const M = 24; // margin around the drawing

/** role -> colour (validated categorical slots: green, blue, orange, violet; red = not reachable) */
export const useRoleColors = () => {
  const dark = useTheme().palette.mode === 'dark';
  const theme = useTheme();
  return {
    primary: dark ? '#199e70' : '#1baf7a',
    standalone: dark ? '#9085e9' : '#4a3aa7',
    standby: dark ? '#3987e5' : '#2a78d6',
    subscriber: dark ? '#d95926' : '#eb6834',
    unknown: theme.palette.error.main,
    external: theme.palette.text.secondary,
    streaming: dark ? '#3987e5' : '#2a78d6',
    logical: dark ? '#d95926' : '#eb6834',
    bad: theme.palette.error.main,
  };
};

export const roleKey = (n: DNode) => (n.external ? 'external' : !n.reachable ? 'unknown' : n.role);

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** The architecture as a diagram: one frame per physical cluster, arrows for replication. */
const Topology: FC<{ result: DResult; selected?: string; onSelect: (id: string) => void }> = ({
  result,
  selected,
  onSelect,
}) => {
  const { t } = useTranslation('discover');
  const theme = useTheme();
  const c = useRoleColors();
  const [hover, setHover] = useState<string | null>(null);
  const lay = useMemo(() => layout(result.nodes, result.edges, result.groups), [result]);
  const ink = theme.palette.text.primary;
  const muted = theme.palette.text.secondary;
  const surface = theme.palette.background.paper;
  const frameFill = theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(19,35,63,0.025)';

  const edgeText = (e: DResult['edges'][number]) => {
    if (e.kind === 'logical') return clip(e.label ?? t('logical'), 34);
    const parts = [e.sync && e.sync !== 'async' ? e.sync : t('async')];
    if (!e.healthy) parts.push(e.state || t('notStreaming'));
    else parts.push(t('lag', { value: bytes(e.lag_bytes) }));
    return parts.join(' · ');
  };

  return (
    <Box>
      <Box
        sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.default' }}>
        <svg
          viewBox={`0 0 ${lay.width + 2 * M} ${lay.height + 2 * M}`}
          width="100%"
          style={{ minWidth: Math.min(lay.width + 2 * M, 900), display: 'block' }}
          role="img"
          aria-label={result.architecture}>
          <defs>
            {(['streaming', 'logical', 'bad'] as const).map((k) => (
              <marker
                key={k}
                id={`arrow-${k}`}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill={c[k]} />
              </marker>
            ))}
          </defs>
          <g transform={`translate(${M},${M})`}>
            {/* cluster frames */}
            {lay.frames
              .filter((f) => f.framed)
              .map((f) => (
                <g key={f.group.id}>
                  <rect
                    x={f.x}
                    y={f.y}
                    width={f.w}
                    height={f.h}
                    rx={14}
                    fill={frameFill}
                    stroke={theme.palette.divider}
                  />
                  <text x={f.x + 16} y={f.y + 22} fontSize={12.5} fontWeight={700} fill={ink}>
                    {clip(f.group.name, 30)}
                  </text>
                  <text x={f.x + f.w - 16} y={f.y + 22} fontSize={11} textAnchor="end" fill={muted}>
                    {f.group.members.length > 1
                      ? f.group.ha
                        ? clip(f.group.ha.startsWith('none') ? t('manualFailover') : f.group.ha, 26)
                        : ''
                      : t('ownCluster')}
                  </text>
                </g>
              ))}

            {/* arrows */}
            {lay.paths.map((p, i) => {
              const k = !p.edge.healthy ? 'bad' : p.edge.kind;
              const active = hover && (p.edge.from === hover || p.edge.to === hover);
              return (
                <path
                  key={i}
                  d={p.d}
                  fill="none"
                  stroke={c[k]}
                  strokeWidth={active ? 3 : 2}
                  strokeDasharray={p.edge.kind === 'logical' ? '7 5' : undefined}
                  markerEnd={`url(#arrow-${k})`}
                  opacity={hover && !active ? 0.35 : 1}
                />
              );
            })}
            {lay.paths.map((p, i) => {
              const text = edgeText(p.edge);
              const w = text.length * 6.3 + 18;
              const k = !p.edge.healthy ? 'bad' : p.edge.kind;
              return (
                <g key={`l${i}`} transform={`translate(${p.lx - w / 2},${p.ly - 11})`}>
                  <rect width={w} height={22} rx={11} fill={surface} stroke={c[k]} strokeWidth={1} />
                  <text x={w / 2} y={15} fontSize={11} textAnchor="middle" fill={ink}>
                    {text}
                  </text>
                </g>
              );
            })}

            {/* servers */}
            {result.nodes.map((n) => {
              const b = lay.boxes[n.id];
              if (!b) return null;
              const key = roleKey(n);
              const color = c[key as keyof typeof c] ?? c.unknown;
              const sel = selected === n.id;
              const dbs = (n.databases ?? []).length;
              const size = (n.databases ?? []).reduce((s, d) => s + d.size_bytes, 0);
              const conns = Object.values(n.connections ?? {}).reduce((s, v) => s + v, 0);
              const line3 = n.external
                ? t('notInInventory')
                : !n.reachable
                  ? clip(n.error ?? t('unreachable'), 36)
                  : `${t('dbs', { count: dbs })} · ${bytes(size)} · ${conns}/${n.max_connections ?? '—'} ${t('conn')}`;
              return (
                <g
                  key={n.id}
                  transform={`translate(${b.x},${b.y})`}
                  style={{ cursor: 'pointer' }}
                  onClick={() => onSelect(n.id)}
                  onPointerEnter={() => setHover(n.id)}
                  onPointerLeave={() => setHover(null)}>
                  <rect
                    width={BOX.w}
                    height={BOX.h}
                    rx={12}
                    fill={surface}
                    stroke={sel ? color : theme.palette.divider}
                    strokeWidth={sel ? 2.5 : 1}
                    strokeDasharray={n.external || !n.reachable ? '5 4' : undefined}
                  />
                  <rect width={6} height={BOX.h - 24} x={0} y={12} rx={3} fill={color} />
                  <rect
                    x={16}
                    y={12}
                    rx={9}
                    height={18}
                    width={t(`role_${key}`).length * 6.6 + 16}
                    fill={color}
                    opacity={0.14}
                  />
                  <text x={24} y={25} fontSize={10.5} fontWeight={700} fill={color} letterSpacing={0.4}>
                    {t(`role_${key}`).toUpperCase()}
                  </text>
                  <text x={BOX.w - 12} y={25} fontSize={10.5} textAnchor="end" fill={muted}>
                    {n.version?.replace('PostgreSQL ', 'PG ') ?? ''}
                  </text>
                  <text x={16} y={52} fontSize={14} fontWeight={700} fill={ink}>
                    {clip(n.name || n.host, 26)}
                  </text>
                  <text x={16} y={70} fontSize={11.5} fill={muted} fontFamily='"JetBrains Mono", monospace'>
                    {clip(n.external && !n.port ? n.host : `${n.host}:${n.port}`, 30)}
                  </text>
                  <text x={16} y={90} fontSize={11} fill={!n.reachable && !n.external ? c.unknown : muted}>
                    {line3}
                  </text>
                  {n.stack?.includes('Patroni') ? (
                    <text x={BOX.w - 12} y={90} fontSize={10.5} textAnchor="end" fontWeight={700} fill={color}>
                      Patroni
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </Box>
      {/* legend */}
      <Stack direction="row" gap={2.5} flexWrap="wrap" mt={1} alignItems="center">
        {(['primary', 'standby', 'subscriber', 'standalone', 'unknown'] as const).map((k) => (
          <Stack key={k} direction="row" gap={0.75} alignItems="center">
            <Box sx={{ width: 10, height: 10, borderRadius: 0.5, bgcolor: c[k] }} />
            <Typography variant="caption" color="text.secondary">
              {t(`role_${k}`)}
            </Typography>
          </Stack>
        ))}
        <Stack direction="row" gap={0.75} alignItems="center">
          <svg width="26" height="8">
            <line x1="0" y1="4" x2="26" y2="4" stroke={c.streaming} strokeWidth="2" />
          </svg>
          <Typography variant="caption" color="text.secondary">
            {t('legendStreaming')}
          </Typography>
        </Stack>
        <Stack direction="row" gap={0.75} alignItems="center">
          <svg width="26" height="8">
            <line x1="0" y1="4" x2="26" y2="4" stroke={c.logical} strokeWidth="2" strokeDasharray="6 4" />
          </svg>
          <Typography variant="caption" color="text.secondary">
            {t('legendLogical')}
          </Typography>
        </Stack>
        <Stack direction="row" gap={0.75} alignItems="center">
          <svg width="26" height="8">
            <line x1="0" y1="4" x2="26" y2="4" stroke={c.bad} strokeWidth="2" />
          </svg>
          <Typography variant="caption" color="text.secondary">
            {t('legendBroken')}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {t('clickNode')}
        </Typography>
      </Stack>
    </Box>
  );
};

export default Topology;
