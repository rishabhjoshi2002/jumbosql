/**
 * pg_mantra Upgrades: from a dry run's results, the order the nodes will be done in and what happens on each -
 * for the upgrade and for its rollback.
 */
import { UComponent, UDetect, UHostResult } from '@shared/api/api/upgrade.ts';

export type Change = { name: string; from: string; to: string };
export type PlanHost = {
  host: string;
  role: string;
  changes: Change[];
  detect?: UDetect;
  steps: string[];
  rollback: string[];
  warnings: string[];
  error?: string;
};

const LEADER = ['leader', 'master', 'primary', 'standby_leader'];

export const changesOf = (d?: UDetect): Change[] => {
  if (!d) return [];
  const out: Change[] = (d.packages ?? [])
    .filter((p) => p.candidate)
    .map((p) => ({ name: p.name, from: p.installed, to: p.candidate }));
  if (d.pip?.candidate) out.push({ name: `${d.pip.name} (pip)`, from: d.pip.installed, to: d.pip.candidate });
  if (d.binary?.candidate) out.push({ name: 'binaries', from: d.binary.installed, to: d.binary.candidate });
  return out;
};

type T = (k: string, o?: Record<string, unknown>) => string;

/** the nodes in the order the playbook takes them, with the steps on each */
export const planOf = (results: UHostResult[], comp: UComponent | undefined, t: T): PlanHost[] => {
  const hosts = results.filter((r) => r.phase === 'plan').map((r) => ({ r, role: r.detect?.patroni?.role ?? '' }));
  const ordered =
    comp?.order === 'replicas_first'
      ? [...hosts.filter((h) => !LEADER.includes(h.role)), ...hosts.filter((h) => LEADER.includes(h.role))]
      : hosts;
  const firstReplica = ordered.find((h) => !LEADER.includes(h.role));
  return ordered.map(({ r, role }) => {
    const d = r.detect;
    const changes = changesOf(d);
    const steps: string[] = [];
    const rollback: string[] = [];
    const services = (d?.services ?? []).filter((s) => s.active).map((s) => s.name);
    const restart =
      comp?.name === 'postgres'
        ? t('s_restartPg')
        : services.length
          ? t('s_restartSvc', { list: services.join(', ') })
          : t('s_noRestart');
    if (!d?.ok) {
      return {
        host: r.host,
        role,
        changes,
        detect: d,
        steps,
        rollback,
        warnings: d?.warnings ?? [],
        error: d?.error ?? t('unreachable'),
      };
    }
    if (changes.length) {
      if (comp?.name === 'patroni') steps.push(t('s_pause'));
      if (comp?.name === 'postgres' && LEADER.includes(role) && hosts.length > 1)
        steps.push(t('s_switchover', { to: firstReplica?.r.detect?.patroni?.member || firstReplica?.r.host || '?' }));
      steps.push(t('s_save', { list: changes.map((c) => `${c.name} ${c.from}`).join(', ') }));
      steps.push(t('s_install', { list: changes.map((c) => `${c.name} ${c.to}`).join(', ') }));
      steps.push(restart);
      steps.push(t('s_wait'));
      if (comp?.name === 'patroni') steps.push(t('s_resume'));

      if (comp?.name === 'patroni') rollback.push(t('s_pause'));
      if (comp?.name === 'postgres' && LEADER.includes(role) && hosts.length > 1) rollback.push(t('s_switchoverBack'));
      rollback.push(t('s_putBack', { list: changes.map((c) => `${c.name} ${c.from}`).join(', ') }));
      rollback.push(restart);
      rollback.push(t('s_wait'));
      if (comp?.name === 'patroni') rollback.push(t('s_resume'));
    } else {
      steps.push(d?.method === 'none' ? t('s_notInstalled') : t('s_nothing'));
    }
    return { host: r.host, role, changes, detect: d, steps, rollback, warnings: d?.warnings ?? [] };
  });
};
