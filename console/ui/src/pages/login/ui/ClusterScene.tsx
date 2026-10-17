import { FC, ReactNode } from 'react';

/**
 * The sign-in illustration: a PostgreSQL HA cluster drawn in true isometric 3D - a primary, two replicas and a
 * backup repository on a grid floor. The only motion is the one the product is about: WAL streaming from the
 * primary to the replicas and to the backup repository, in a steady rhythm along fixed traces, and the
 * primary's heartbeat. Everything is vector, so it is sharp at any size.
 */

const U = 34; // one grid unit, in px
const C = Math.cos(Math.PI / 6) * U;
const S = Math.sin(Math.PI / 6) * U;
const iso = (x: number, y: number, z = 0): [number, number] => [(x - y) * C, (x + y) * S - z * U];
const pts = (...p: [number, number, number][]) => p.map(([x, y, z]) => iso(x, y, z).join(',')).join(' ');

const COL = {
  floor: '#0A1838',
  grid: '#17305E',
  top: '#2F64C4',
  left: '#1A438E',
  right: '#123270',
  edge: '#5A8EE8',
  slot: '#0B2457',
  trace: '#21488F',
  wal: '#5CC4FF',
  gold: '#F4B321',
  label: '#9DB2D8',
  ok: '#3DDC97',
};

type Box = { x: number; y: number; w: number; d: number; h: number; slots: number; led: string; top?: string };

/** a server: three visible faces, slots on the front faces, a status light on each slot */
const Server: FC<Box & { delay: number }> = ({ x, y, w, d, h, slots, led, top = COL.top, delay }) => {
  const x0 = x - w / 2;
  const y0 = y - d / 2;
  const lines: ReactNode[] = [];
  for (let i = 1; i <= slots; i++) {
    const z = (h * i) / (slots + 1);
    // a slot on the right face (x = x0 + w) and on the left face (y = y0 + d)
    lines.push(
      <polyline
        key={`r${i}`}
        points={pts([x0 + w, y0 + 0.18, z], [x0 + w, y0 + d - 0.18, z])}
        stroke={COL.slot}
        strokeWidth={3}
      />,
      <polyline
        key={`l${i}`}
        points={pts([x0 + 0.18, y0 + d, z], [x0 + w - 0.18, y0 + d, z])}
        stroke={COL.slot}
        strokeWidth={3}
      />,
    );
    const [lx, ly] = iso(x0 + w, y0 + d - 0.3, z + 0.12);
    lines.push(
      <circle key={`d${i}`} cx={lx} cy={ly} r={2.2} fill={led}>
        <animate
          attributeName="opacity"
          values="1;.35;1"
          dur="2.4s"
          begin={`${delay + i * 0.3}s`}
          repeatCount="indefinite"
        />
      </circle>,
    );
  }
  return (
    <g className="cs-rise" style={{ animationDelay: `${delay}s` }}>
      <polygon
        points={pts([x0 + w, y0, 0], [x0 + w, y0 + d, 0], [x0 + w, y0 + d, h], [x0 + w, y0, h])}
        fill={COL.right}
      />
      <polygon
        points={pts([x0, y0 + d, 0], [x0 + w, y0 + d, 0], [x0 + w, y0 + d, h], [x0, y0 + d, h])}
        fill={COL.left}
      />
      <polygon
        points={pts([x0, y0, h], [x0 + w, y0, h], [x0 + w, y0 + d, h], [x0, y0 + d, h])}
        fill={top}
        stroke={COL.edge}
        strokeWidth={1}
      />
      <polyline
        points={pts([x0 + w, y0 + d, 0], [x0 + w, y0 + d, h])}
        stroke={COL.edge}
        strokeOpacity={0.5}
        strokeWidth={1}
      />
      {lines}
    </g>
  );
};

/** a trace on the floor from one node to another, with WAL packets running along it at a steady beat */
const Stream: FC<{
  from: [number, number];
  via?: [number, number];
  to: [number, number];
  color: string;
  id: string;
}> = ({ from, via, to, color, id }) => {
  const p = [from, ...(via ? [via] : []), to].map(([x, y]) => iso(x, y, 0.02));
  const d = `M${p.map((q) => q.join(',')).join(' L')}`;
  return (
    <g>
      <path d={d} stroke={COL.trace} strokeWidth={5} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <path d={d} stroke={color} strokeOpacity={0.35} strokeWidth={1.4} fill="none" strokeDasharray="2 7" />
      <path id={id} d={d} fill="none" stroke="none" />
      {[0, 0.8, 1.6].map((b) => (
        <g key={b}>
          <circle r={3.6} fill={color}>
            <animateMotion dur="2.4s" begin={`${b}s`} repeatCount="indefinite" rotate="auto">
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
          <circle r={9} fill={color} opacity={0.18}>
            <animateMotion dur="2.4s" begin={`${b}s`} repeatCount="indefinite">
              <mpath href={`#${id}`} />
            </animateMotion>
          </circle>
        </g>
      ))}
    </g>
  );
};

const Label: FC<{ x: number; y: number; text: string; sub: string; gold?: boolean; left?: boolean }> = ({
  x,
  y,
  text,
  sub,
  gold,
  left,
}) => {
  const [bx, by] = iso(x, y, 0);
  const [lx, ly, anchor] = left ? [bx + 74, by - 62, 'start'] : [bx, by + 48, 'middle'];
  return (
    <g>
      <text x={lx} y={ly} textAnchor={anchor} fontSize={13} fontWeight={700} fill={gold ? COL.gold : '#E3EBF8'}>
        {text}
      </text>
      <text x={lx} y={ly + 16} textAnchor={anchor} fontSize={11} fill={COL.label}>
        {sub}
      </text>
    </g>
  );
};

const ClusterScene: FC<{ width?: number | string }> = ({ width = '100%' }) => {
  // the floor: a diamond grid, 7 units each way from the centre
  const N = 6;
  const grid: ReactNode[] = [];
  for (let i = -N; i <= N; i++) {
    const fade = 1 - Math.abs(i) / (N + 1);
    grid.push(
      <polyline
        key={`gx${i}`}
        points={pts([i, -N, 0], [i, N, 0])}
        stroke={COL.grid}
        strokeOpacity={fade}
        strokeWidth={1}
      />,
      <polyline
        key={`gy${i}`}
        points={pts([-N, i, 0], [N, i, 0])}
        stroke={COL.grid}
        strokeOpacity={fade}
        strokeWidth={1}
      />,
    );
  }
  const [px, py] = iso(0, 0, 0);
  const W = 2 * N * C + 40;
  return (
    <svg
      viewBox={`${-W / 2} ${-N * S - 2.6 * U} ${W} ${2 * N * S + 4.4 * U}`}
      width={width}
      role="img"
      aria-label="A primary PostgreSQL server streaming to two replicas and a backup repository"
      style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id="cs-floor" cx="50%" cy="50%" r="50%">
          <stop offset="0" stopColor="#14306A" stopOpacity="0.9" />
          <stop offset="1" stopColor={COL.floor} stopOpacity="0" />
        </radialGradient>
        <style>{`
          .cs-rise { animation: csRise .9s cubic-bezier(.2,.8,.2,1) both; }
          @keyframes csRise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }
          @media (prefers-reduced-motion: reduce) { .cs-rise { animation: none; } animate, animateMotion { display: none; } }
        `}</style>
      </defs>
      <polygon points={pts([-N, -N, 0], [N, -N, 0], [N, N, 0], [-N, N, 0])} fill="url(#cs-floor)" />
      {grid}

      {/* WAL: primary -> replicas (blue), primary -> backup repository (gold) */}
      <Stream id="cs-r1" from={[0.9, 0]} to={[3.7, 0]} color={COL.wal} />
      <Stream id="cs-r2" from={[0, 0.9]} to={[0, 3.7]} color={COL.wal} />
      <Stream id="cs-bk" from={[-0.9, 0]} via={[-5.6, 0]} to={[-5.6, -1.2]} color={COL.gold} />

      {/* the primary's heartbeat on the floor */}
      <ellipse cx={px} cy={py} rx={C * 1.2} ry={S * 1.2} fill="none" stroke={COL.gold} strokeWidth={1.5}>
        <animate attributeName="rx" values={`${C * 1.2};${C * 2.4}`} dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="ry" values={`${S * 1.2};${S * 2.4}`} dur="2.4s" repeatCount="indefinite" />
        <animate attributeName="opacity" values=".7;0" dur="2.4s" repeatCount="indefinite" />
      </ellipse>

      {/* drawn back to front */}
      <Server x={-5.6} y={-2} w={2} d={1.6} h={1} slots={2} led={COL.gold} delay={0.1} />
      <Server x={0} y={0} w={1.7} d={1.7} h={1.9} slots={4} led={COL.gold} top="#3A74DA" delay={0} />
      <Server x={4.5} y={0} w={1.5} d={1.5} h={1.5} slots={3} led={COL.ok} delay={0.2} />
      <Server x={0} y={4.5} w={1.5} d={1.5} h={1.5} slots={3} led={COL.ok} delay={0.3} />

      <Label x={-5.6} y={-2} text="Backup" sub="pgBackRest repository" left />
      <Label x={0} y={0} text="Primary" sub="read · write" gold />
      <Label x={4.5} y={0} text="Replica" sub="streaming" />
      <Label x={0} y={4.5} text="Replica" sub="streaming" />
    </svg>
  );
};

export default ClusterScene;
