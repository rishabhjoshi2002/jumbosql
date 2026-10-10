import { describe, expect, it } from 'vitest';
import { DComponent, DHost, DInfra } from '@shared/api/api/discover.ts';
import { infraLayout } from './infraLayout.ts';

const comp = (
  kind: string,
  layer: DComponent['layer'],
  ports: number[] = [],
  details?: Record<string, string>,
): DComponent => ({
  kind,
  layer,
  label: kind,
  running: true,
  ports,
  sources: ['package'],
  details,
});
const host = (address: string, name: string, components: DComponent[], vips: string[] = []): DHost => ({
  address,
  name,
  reachable: true,
  open_ports: [],
  ssh: 'ok',
  components,
  roles: [],
  vips,
});

describe('infraLayout', () => {
  const inf: DInfra = {
    stack: 'x',
    summary: [],
    vips: ['10.0.0.100'],
    ssh_used: true,
    hosts: [
      host('10.0.0.9', 'lb1', [comp('keepalived', 'entry'), comp('haproxy', 'balancer', [5000])], ['10.0.0.100']),
      host('10.0.0.1', 'pg1', [
        comp('pgbouncer', 'pooler', [6432]),
        comp('postgres', 'database', [5432]),
        comp('patroni', 'ha'),
      ]),
      host('10.0.0.2', 'pg2', [comp('postgres', 'database', [5432]), comp('etcd', 'dcs')]),
    ],
    routes: [
      {
        host: '10.0.0.9',
        kind: 'haproxy',
        name: 'master',
        port: 5000,
        targets: ['10.0.0.1:6432', '10.0.0.2:5432'],
        resolved: [],
      },
    ],
  };
  const lay = infraLayout(inf, []);

  it('puts each machine in the lanes of what it runs, top to bottom', () => {
    expect(lay.lanes.map((l) => l.lane)).toEqual(['entry', 'balancer', 'pooler', 'database', 'dcs']);
    const db = lay.boxes.find((b) => b.id === 'database/10.0.0.1')!;
    expect(db.lines.map((l) => l.kind)).toEqual(['postgres', 'patroni']); // HA sits with PostgreSQL
    expect(lay.boxes.find((b) => b.id === 'pooler/10.0.0.1')!.y).toBeLessThan(db.y);
  });

  it('follows the routes: to the pooler when the port is the pooler’s, else to PostgreSQL', () => {
    const pairs = lay.edges.map((e) => `${e.from}>${e.to}`);
    expect(pairs).toContain('entry/10.0.0.100>balancer/10.0.0.9');
    expect(pairs).toContain('balancer/10.0.0.9>pooler/10.0.0.1');
    expect(pairs).toContain('balancer/10.0.0.9>database/10.0.0.2');
    expect(pairs).toContain('pooler/10.0.0.1>database/10.0.0.1');
    expect(pairs).not.toContain('balancer/10.0.0.9>database/10.0.0.1');
  });
});
