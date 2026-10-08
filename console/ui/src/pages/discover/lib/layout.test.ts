import { describe, expect, it } from 'vitest';
import { DEdge, DGroup, DNode } from '@shared/api/api/discover.ts';
import { BOX, layout } from './layout';

const node = (id: string, role: string, group: string): DNode =>
  ({ id, host: id, port: 5432, reachable: true, role, group, login_is_superuser: true }) as DNode;

describe('discover layout', () => {
  it('puts standbys under their primary and logical replicas to the right', () => {
    const nodes = [
      node('p', 'primary', 'g1'),
      node('s1', 'standby', 'g1'),
      node('s2', 'standby', 'g1'),
      node('l', 'subscriber', 'g2'),
    ];
    const edges: DEdge[] = [
      { from: 'p', to: 's1', kind: 'streaming', lag_bytes: 0, replay_lag_seconds: 0, healthy: true },
      { from: 's1', to: 's2', kind: 'streaming', lag_bytes: 0, replay_lag_seconds: 0, healthy: true },
      { from: 'p', to: 'l', kind: 'logical', lag_bytes: 0, replay_lag_seconds: 0, healthy: true, label: 'pub' },
    ];
    const groups: DGroup[] = [
      { id: 'g1', system_id: '1', name: 'prod', primary: 'p', members: ['p', 's1', 's2'], ha: '' },
      { id: 'g2', system_id: '2', name: 'report', primary: 'l', members: ['l'], ha: '' },
    ];
    const l = layout(nodes, edges, groups);
    expect(l.boxes.s1.y).toBeGreaterThan(l.boxes.p.y);
    expect(l.boxes.s2.y).toBeGreaterThan(l.boxes.s1.y); // cascading: one level lower
    expect(l.boxes.l.x).toBeGreaterThan(l.boxes.p.x + BOX.w);
    expect(l.paths).toHaveLength(3);
    expect(l.frames.filter((f) => f.framed)).toHaveLength(2);
  });
});
