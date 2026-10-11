import { describe, expect, it } from 'vitest';
import { UComponent, UHostResult } from '@shared/api/api/upgrade.ts';
import { planOf } from './plan.ts';

const t = (k: string, o?: Record<string, unknown>) => (o ? `${k}:${Object.values(o).join('|')}` : k);
const comp: UComponent = {
  name: 'postgres',
  label: 'PostgreSQL',
  groups: [],
  order: 'replicas_first',
  restart: '',
  notes: [],
};
const host = (h: string, role: string, member: string): UHostResult => ({
  host: h,
  phase: 'plan',
  detect: {
    ok: true,
    method: 'package',
    packages: [{ name: 'postgresql17-server', installed: '17.5-1PGDG', candidate: '17.6-1PGDG' }],
    patroni: { role, member },
  },
});

describe('planOf', () => {
  const plan = planOf([host('pg1', 'leader', 'pgnode01'), host('pg2', 'replica', 'pgnode02')], comp, t);
  it('does the standbys first and the primary last', () => {
    expect(plan.map((p) => p.host)).toEqual(['pg2', 'pg1']);
  });
  it('switches over before the primary, keeps then installs', () => {
    expect(plan[1].steps[0]).toBe('s_switchover:pgnode02');
    expect(plan[1].steps[1]).toContain('17.5-1PGDG');
    expect(plan[1].steps[2]).toContain('17.6-1PGDG');
    expect(plan[0].steps.some((s) => s.startsWith('s_switchover'))).toBe(false);
    expect(plan[0].rollback[0]).toContain('s_putBack');
  });
});
