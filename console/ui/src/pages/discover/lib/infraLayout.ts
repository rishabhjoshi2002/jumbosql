/**
 * pg_mantra Discover: the machines as lanes, top to bottom in the order a connection travels -
 * virtual IP, load balancer, pooler, PostgreSQL - then the HA store, backups and monitoring.
 * One box per machine and lane; arrows follow the balancer routes and pooler targets.
 */
import { DComponent, DHost, DInfra, DNode } from '@shared/api/api/discover.ts';

export const LANES = ['entry', 'balancer', 'pooler', 'database', 'dcs', 'backup', 'monitoring'] as const;
export type Lane = (typeof LANES)[number];

export const IBOX = { w: 220, head: 46, line: 17, pad: 10 };
const GAP_X = 26;
const GAP_Y = 54;
export const LABEL_W = 128;

export type IBox = {
  id: string; // lane/address
  lane: Lane;
  host?: DHost; // undefined for a VIP box
  title: string;
  subtitle: string;
  lines: { text: string; running: boolean; kind: string }[];
  pgRole?: string;
  x: number;
  y: number;
  h: number;
};
export type IEdge = { from: string; to: string; label: string; d: string; lx: number; ly: number; kind: string };
export type ILink = { from: string; to: string; kind: string; port?: number; d: string; hosts: [string, string] };
export type ILayout = {
  width: number;
  height: number;
  boxes: IBox[];
  edges: IEdge[];
  links: ILink[];
  lanes: { lane: Lane; y: number; h: number }[];
};

const laneOf = (c: DComponent): Lane | null =>
  c.layer === 'ha' ? 'database' : (LANES as readonly string[]).includes(c.layer) ? (c.layer as Lane) : null;

export const hostLabel = (h: DHost) => (h.name && h.name !== h.address ? h.name : h.address);

const addrHost = (t: string) => {
  const s = t.replace(/^\[|\]$/g, '');
  const i = s.lastIndexOf(':');
  return i > 0 && !s.slice(0, i).includes(':') ? [s.slice(0, i), Number(s.slice(i + 1))] : [s, 0];
};

export const findHost = (hosts: DHost[], addr: string) => {
  const a = addr.toLowerCase();
  return hosts.find(
    (h) => h.address.toLowerCase() === a || (h.name ?? '').toLowerCase() === a || (h.name ?? '').split('.')[0] === a,
  );
};

export const infraLayout = (inf: DInfra, nodes: DNode[]): ILayout => {
  const byLane: Record<Lane, IBox[]> = {
    entry: [],
    balancer: [],
    pooler: [],
    database: [],
    dcs: [],
    backup: [],
    monitoring: [],
  };
  // virtual IPs: one box each, held by the keepalived / vip-manager machines
  inf.vips.forEach((v) => {
    const holders = inf.hosts.filter((h) => (h.vips ?? []).includes(v)).map(hostLabel);
    byLane.entry.push({
      id: `entry/${v}`,
      lane: 'entry',
      title: `VIP ${v}`,
      subtitle: holders.join(', '),
      lines: [],
      x: 0,
      y: 0,
      h: 0,
    });
  });
  inf.hosts.forEach((h) => {
    const lanes: Partial<Record<Lane, DComponent[]>> = {};
    // exporters are agents: they get a line in the machine's other box, a monitoring box only when alone
    const agents = h.components.filter((c) => c.kind.endsWith('_exporter'));
    h.components.forEach((c) => {
      const l = laneOf(c);
      if (!l || l === 'entry' || agents.includes(c)) return;
      (lanes[l] ??= []).push(c);
    });
    if (agents.length) {
      const host = (Object.keys(lanes) as Lane[]).sort((a, b) => LANES.indexOf(b) - LANES.indexOf(a))[0];
      if (host && host !== 'monitoring') {
        lanes[host]!.push({
          ...agents[0],
          kind: 'agents',
          label: '+ ' + agents.map((a) => a.label).join(', '),
          version: undefined,
          ports: [],
          running: agents.some((a) => a.running),
        });
      } else {
        (lanes.monitoring ??= []).push(...agents);
      }
    }
    (Object.keys(lanes) as Lane[]).forEach((l) => {
      const node = nodes.find((n) => !n.external && n.host === h.address && n.reachable);
      byLane[l].push({
        id: `${l}/${h.address}`,
        lane: l,
        host: h,
        title: hostLabel(h),
        subtitle: h.address,
        lines: lanes[l]!.map((c) => ({
          kind: c.kind,
          running: c.running,
          text: [
            c.label,
            c.version,
            (c.ports ?? [])
              .slice(0, 3)
              .map((p) => `:${p}`)
              .join(' '),
          ]
            .filter(Boolean)
            .join('  '),
        })),
        pgRole: l === 'database' ? node?.role : undefined,
        x: 0,
        y: 0,
        h: 0,
      });
    });
  });

  // place lanes
  const used = LANES.filter((l) => byLane[l].length);
  const maxCount = Math.max(1, ...used.map((l) => byLane[l].length));
  const innerW = maxCount * IBOX.w + (maxCount - 1) * GAP_X;
  const lanes: ILayout['lanes'] = [];
  let y = 0;
  used.forEach((l) => {
    const list = byLane[l];
    const h = Math.max(...list.map((b) => IBOX.head + Math.max(1, b.lines.length) * IBOX.line + IBOX.pad));
    const rowW = list.length * IBOX.w + (list.length - 1) * GAP_X;
    const x0 = LABEL_W + (innerW - rowW) / 2;
    list.forEach((b, i) => {
      b.x = x0 + i * (IBOX.w + GAP_X);
      b.y = y;
      b.h = h;
    });
    lanes.push({ lane: l, y, h });
    y += h + GAP_Y;
  });
  const boxes = used.flatMap((l) => byLane[l]);
  const box = (id: string) => boxes.find((b) => b.id === id);

  // arrows (top to bottom only)
  const edges: IEdge[] = [];
  const seen = new Set<string>();
  const link = (from: IBox | undefined, to: IBox | undefined, label: string, kind: string) => {
    if (!from || !to || from === to || to.y <= from.y) return;
    const key = `${from.id}>${to.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const x1 = from.x + IBOX.w / 2;
    const y1 = from.y + from.h;
    const x2 = to.x + IBOX.w / 2;
    const y2 = to.y;
    const my = (y1 + y2) / 2;
    edges.push({
      from: from.id,
      to: to.id,
      label,
      kind,
      d: `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`,
      lx: (x1 + x2) / 2,
      ly: my,
    });
  };
  // VIP -> the balancers on the machines that hold it (else every balancer)
  byLane.entry.forEach((v) => {
    const vip = v.title.replace('VIP ', '');
    const holders = byLane.balancer.filter((b) => (b.host?.vips ?? []).includes(vip));
    (holders.length ? holders : byLane.balancer.length ? byLane.balancer : byLane.pooler).forEach((b) =>
      link(v, b, '', 'entry'),
    );
  });
  // balancer routes -> pooler (when the target port is the pooler's) or PostgreSQL
  inf.routes.forEach((r) => {
    const from = box(`balancer/${r.host}`);
    r.targets.forEach((t) => {
      const [hostPart, port] = addrHost(t) as [string, number];
      const th = findHost(inf.hosts, hostPart);
      if (!th) return;
      const pool = box(`pooler/${th.address}`);
      const poolPorts = th.components.filter((c) => c.layer === 'pooler').flatMap((c) => c.ports ?? []);
      const to = pool && poolPorts.includes(port) ? pool : box(`database/${th.address}`);
      link(from, to, String(r.port), r.kind);
    });
  });
  // pooler -> PostgreSQL (the servers in its [databases] section, else the same machine)
  byLane.pooler.forEach((p) => {
    const dbs = p.host?.components.find((c) => c.layer === 'pooler')?.details?.databases ?? '';
    const targets = [...dbs.matchAll(/host=([^\s;]+)/g)]
      .map((m) => findHost(inf.hosts, m[1]))
      .filter(Boolean) as DHost[];
    const list = targets.length ? targets : p.host ? [p.host] : [];
    list.forEach((th) => link(p, box(`database/${th.address}`), '', 'pooler'));
  });

  // connections seen live, in configs or APIs (etcd, Patroni checks, scrapes, replication, ...)
  const links: ILink[] = [];
  const linkSeen = new Set<string>();
  const hostBox = (addr: string, prefer: Lane[]) => {
    const own = boxes.filter((b) => b.host?.address === addr);
    for (const l of prefer) {
      const b = own.find((x) => x.lane === l);
      if (b) return b;
    }
    return own[0];
  };
  (inf.links ?? []).forEach((l) => {
    const [fromLanes, toLanes] = LINK_LANES[l.kind] ?? [[], []];
    const a = hostBox(l.from, fromLanes);
    const b = hostBox(l.to, toLanes);
    if (!a || !b || a === b || seen.has(`${a.id}>${b.id}`) || seen.has(`${b.id}>${a.id}`)) return;
    const key = `${a.id}>${b.id}>${l.kind}`;
    if (linkSeen.has(key)) return;
    linkSeen.add(key);
    let d: string;
    if (Math.abs(a.y - b.y) < 1) {
      // same lane: an arc over the boxes
      const x1 = a.x + IBOX.w / 2;
      const x2 = b.x + IBOX.w / 2;
      const top = a.y - 18 - Math.min(40, Math.abs(x2 - x1) / 8);
      d = `M${x1},${a.y} C${x1},${top} ${x2},${top} ${x2},${b.y}`;
    } else {
      const down = b.y > a.y;
      const x1 = a.x + IBOX.w / 2 + (down ? 18 : -18);
      const x2 = b.x + IBOX.w / 2 + (down ? 18 : -18);
      const y1 = down ? a.y + a.h : a.y;
      const y2 = down ? b.y : b.y + b.h;
      const my = (y1 + y2) / 2;
      d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
    }
    links.push({ from: a.id, to: b.id, kind: l.kind, port: l.port, d, hosts: [l.from, l.to] });
  });

  return { width: LABEL_W + innerW, height: Math.max(0, y - GAP_Y), boxes, edges, links, lanes };
};

/** which box of each machine a link starts and ends at */
const LINK_LANES: Record<string, [Lane[], Lane[]]> = {
  etcd: [['database', 'dcs'], ['dcs']],
  patroni: [['balancer', 'database'], ['database']],
  metrics: [['monitoring'], ['database', 'pooler', 'balancer', 'dcs', 'backup', 'entry']],
  prometheus: [['monitoring'], ['monitoring']],
  postgres: [['pooler', 'balancer', 'database'], ['database']],
  pgbouncer: [['pooler'], ['database']],
  balancer: [['balancer'], ['pooler', 'database']],
  replication: [['database'], ['database']],
  backup: [
    ['backup', 'database'],
    ['database', 'backup'],
  ],
  vip: [
    ['entry', 'balancer'],
    ['balancer', 'entry'],
  ],
};
