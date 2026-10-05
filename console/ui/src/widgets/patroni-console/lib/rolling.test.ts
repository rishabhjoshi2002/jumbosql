import { describe, expect, it } from 'vitest';
import { memberIsBack, planRollingRestart } from './rolling';

const m = (name: string, role: string, state: string, lag: number | string = 0) => ({
  name,
  role,
  state,
  host: name,
  lag,
});

describe('planRollingRestart', () => {
  it('restarts replicas first, switches over, then restarts the old leader', () => {
    const steps = planRollingRestart([
      m('ip24_pg1', 'leader', 'running'),
      m('ip26_pg3', 'replica', 'streaming'),
      m('ip25_pg2', 'replica', 'streaming'),
    ]);
    expect(steps).toEqual([
      { kind: 'restart', member: 'ip25_pg2' },
      { kind: 'wait', member: 'ip25_pg2' },
      { kind: 'restart', member: 'ip26_pg3' },
      { kind: 'wait', member: 'ip26_pg3' },
      { kind: 'switchover', from: 'ip24_pg1', to: 'ip25_pg2' },
      { kind: 'restart', member: 'ip24_pg1' },
      { kind: 'wait', member: 'ip24_pg1' },
    ]);
  });

  it('refuses without a leader or without replicas', () => {
    expect(() => planRollingRestart([m('a', 'replica', 'streaming')])).toThrow(/no leader/);
    expect(() => planRollingRestart([m('a', 'leader', 'running')])).toThrow(/at least one replica/);
  });
});

describe('memberIsBack', () => {
  it('waits for a streaming replica without unknown lag', () => {
    expect(memberIsBack([m('a', 'replica', 'starting')], 'a')).toBe(false);
    expect(memberIsBack([m('a', 'replica', 'streaming', 'unknown')], 'a')).toBe(false);
    expect(memberIsBack([m('a', 'replica', 'streaming', 0)], 'a')).toBe(true);
    expect(memberIsBack([m('a', 'leader', 'running')], 'a')).toBe(true);
    expect(memberIsBack([], 'a')).toBe(false);
  });
});
