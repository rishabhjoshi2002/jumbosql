import { FC, useMemo, useState } from 'react';
import { Box, Stack, Typography, useTheme } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { DInfra, DNode } from '@shared/api/api/discover.ts';
import { IBOX, infraLayout } from '../lib/infraLayout.ts';
import { useRoleColors } from './Topology.tsx';

const M = 20;
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** lane colours: validated categorical slots, one per lane */
export const useLaneColors = () => {
  const dark = useTheme().palette.mode === 'dark';
  return {
    entry: dark ? '#d55181' : '#e87ba4',
    balancer: dark ? '#d95926' : '#eb6834',
    pooler: dark ? '#c98500' : '#eda100',
    database: dark ? '#199e70' : '#1baf7a',
    dcs: dark ? '#9085e9' : '#4a3aa7',
    backup: dark ? '#3987e5' : '#2a78d6',
    monitoring: dark ? '#008300' : '#008300',
  } as Record<string, string>;
};

/** The machines and what runs on them, in the order a connection travels. */
const InfraDiagram: FC<{ infra: DInfra; nodes: DNode[]; selected?: string; onSelect: (address: string) => void }> = ({
  infra,
  nodes,
  selected,
  onSelect,
}) => {
  const { t } = useTranslation('discover');
  const theme = useTheme();
  const lane = useLaneColors();
  const role = useRoleColors();
  const [hover, setHover] = useState<string | null>(null);
  const lay = useMemo(() => infraLayout(infra, nodes), [infra, nodes]);
  const ink = theme.palette.text.primary;
  const muted = theme.palette.text.secondary;
  const surface = theme.palette.background.paper;
  const W = lay.width + 2 * M + 40;

  if (!lay.boxes.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        {t('i_nothing')}
      </Typography>
    );
  }
  return (
    <Box>
      <Box
        sx={{ overflowX: 'auto', border: 1, borderColor: 'divider', borderRadius: 2, bgcolor: 'background.default' }}>
        <svg
          viewBox={`0 0 ${W} ${lay.height + 2 * M}`}
          style={{
            display: 'block',
            margin: '0 auto',
            width: '100%',
            height: 'auto',
            maxWidth: W,
            minWidth: Math.min(W, 860),
          }}
          role="img"
          aria-label={infra.stack}>
          <defs>
            <marker id="iarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
              <path d="M0,0 L10,5 L0,10 z" fill={muted} />
            </marker>
          </defs>
          <g transform={`translate(${M},${M})`}>
            {lay.lanes.map((l) => (
              <g key={l.lane}>
                <rect x={0} y={l.y} width={lay.width + 40} height={l.h} rx={10} fill={lane[l.lane]} opacity={0.06} />
                <rect x={0} y={l.y + 10} width={4} height={l.h - 20} rx={2} fill={lane[l.lane]} />
                <text x={14} y={l.y + 24} fontSize={12} fontWeight={700} fill={ink}>
                  {t(`lane_${l.lane}`)}
                </text>
                <text x={14} y={l.y + 40} fontSize={10.5} fill={muted}>
                  {clip(t(`lane_${l.lane}_help`), 20)}
                </text>
              </g>
            ))}
            {lay.edges.map((e, i) => {
              const active = hover && (e.from.endsWith(`/${hover}`) || e.to.endsWith(`/${hover}`));
              return (
                <path
                  key={i}
                  d={e.d}
                  fill="none"
                  stroke={muted}
                  strokeWidth={active ? 2.4 : 1.4}
                  opacity={hover && !active ? 0.25 : 0.8}
                  markerEnd="url(#iarrow)"
                />
              );
            })}
            {lay.edges
              .filter((e) => e.label)
              .map((e, i) => {
                const w = e.label.length * 6.5 + 14;
                return (
                  <g key={`l${i}`} transform={`translate(${e.lx - w / 2},${e.ly - 9})`}>
                    <rect width={w} height={18} rx={9} fill={surface} stroke={theme.palette.divider} />
                    <text x={w / 2} y={13} fontSize={10.5} textAnchor="middle" fill={ink}>
                      {e.label}
                    </text>
                  </g>
                );
              })}
            {lay.boxes.map((b) => {
              const color =
                b.lane === 'database' && b.pgRole
                  ? (role[b.pgRole as keyof typeof role] ?? lane.database)
                  : lane[b.lane];
              const addr = b.host?.address;
              const sel = addr && selected === addr;
              const down = b.host && !b.host.reachable;
              return (
                <g
                  key={b.id}
                  transform={`translate(${b.x},${b.y})`}
                  style={{ cursor: addr ? 'pointer' : undefined }}
                  onClick={() => addr && onSelect(addr)}
                  onPointerEnter={() => addr && setHover(addr)}
                  onPointerLeave={() => setHover(null)}>
                  <rect
                    width={IBOX.w}
                    height={b.h}
                    rx={10}
                    fill={surface}
                    stroke={sel ? color : theme.palette.divider}
                    strokeWidth={sel ? 2.5 : 1}
                    strokeDasharray={down ? '5 4' : undefined}
                  />
                  <rect width={5} height={b.h - 20} x={0} y={10} rx={2.5} fill={color} />
                  <text x={14} y={20} fontSize={13} fontWeight={700} fill={ink}>
                    {clip(b.title, 24)}
                  </text>
                  {b.pgRole ? (
                    <text x={IBOX.w - 10} y={20} fontSize={10} fontWeight={700} textAnchor="end" fill={color}>
                      {t(`role_${b.pgRole}`).toUpperCase()}
                    </text>
                  ) : null}
                  <text x={14} y={36} fontSize={10.5} fill={muted} fontFamily='"JetBrains Mono", monospace'>
                    {clip(b.subtitle, 32)}
                  </text>
                  {b.lines.map((l, i) => (
                    <g key={l.kind} transform={`translate(14,${IBOX.head + i * IBOX.line + 6})`}>
                      <circle cx={3} cy={-4} r={3.5} fill={l.running ? theme.palette.success.main : muted} />
                      <text x={12} y={0} fontSize={11.5} fill={ink}>
                        {clip(l.text, 30)}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}
          </g>
        </svg>
      </Box>
      <Stack direction="row" gap={2.5} flexWrap="wrap" mt={1} alignItems="center">
        <Stack direction="row" gap={0.75} alignItems="center">
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'success.main' }} />
          <Typography variant="caption" color="text.secondary">
            {t('i_running')}
          </Typography>
        </Stack>
        <Stack direction="row" gap={0.75} alignItems="center">
          <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'text.secondary' }} />
          <Typography variant="caption" color="text.secondary">
            {t('i_notRunning')}
          </Typography>
        </Stack>
        <Typography variant="caption" color="text.secondary">
          {t('i_arrows')}
        </Typography>
      </Stack>
    </Box>
  );
};

export default InfraDiagram;
