import { PatroniMember } from '@shared/api/api/patroni.ts';

/**
 * pg_genin: rolling restart plan - the order patronictl users follow by hand:
 *   1. restart every replica, one at a time, waiting until it is streaming again
 *   2. switch the leader over to a healthy replica
 *   3. restart the old leader (now a replica)
 * This keeps the cluster writable throughout, apart from the switchover itself.
 * It is also the restart pattern for a minor PostgreSQL upgrade once the new packages are installed.
 */
export type RollingStep =
  | { kind: 'restart'; member: string }
  | { kind: 'wait'; member: string }
  | { kind: 'switchover'; from: string; to: string };

export const isLeader = (m: PatroniMember) => m.role === 'leader' || m.role === 'standby_leader';

export const isHealthyReplica = (m: PatroniMember) =>
  !isLeader(m) && ['streaming', 'running'].includes(m.state) && (typeof m.lag !== 'string' || m.lag === '0');

export const planRollingRestart = (members: PatroniMember[]): RollingStep[] => {
  const leader = members.find(isLeader);
  const replicas = members.filter((m) => !isLeader(m)).sort((a, b) => a.name.localeCompare(b.name));
  if (!leader) throw new Error('The cluster has no leader right now; fix that before a rolling restart.');
  if (!replicas.length) throw new Error('A rolling restart needs at least one replica.');

  const steps: RollingStep[] = [];
  replicas.forEach((r) => {
    steps.push({ kind: 'restart', member: r.name }, { kind: 'wait', member: r.name });
  });
  steps.push({ kind: 'switchover', from: leader.name, to: replicas[0].name });
  steps.push({ kind: 'restart', member: leader.name }, { kind: 'wait', member: leader.name });
  return steps;
};

/** A member is back when it is running/streaming again (and, for the old leader, no longer leading). */
export const memberIsBack = (members: PatroniMember[], name: string) => {
  const m = members.find((x) => x.name === name);
  return !!m && (isLeader(m) ? m.state === 'running' : isHealthyReplica(m));
};
