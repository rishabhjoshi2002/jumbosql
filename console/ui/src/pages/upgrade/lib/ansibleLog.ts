/**
 * pg_mantra: read the runner's Ansible output (default stdout callback) as it streams in, and tell per host
 * what it is doing - for the live picture next to the log.
 */
export type HostState = 'waiting' | 'working' | 'ok' | 'changed' | 'failed' | 'unreachable' | 'skipped';

export type HostProgress = {
  host: string;
  state: HostState;
  task: string; // the last task it reported (or the one it is on)
  tasks: string[]; // tasks it finished, in order
  changed: number;
  error?: string;
  recap?: { ok: number; changed: number; failed: number; unreachable: number; skipped: number };
};

export type LogProgress = {
  hosts: Record<string, HostProgress>;
  order: string[]; // hosts in the order they first appeared
  play: string;
  task: string; // the task Ansible is on now
  finished: boolean; // PLAY RECAP seen
};

const RESULT = /^(ok|changed|skipping|fatal|failed|unreachable):\s*\[([^\]]+)\](.*)$/;
const RECAP = /^(\S+)\s*:\s*ok=(\d+)\s+changed=(\d+)\s+unreachable=(\d+)\s+failed=(\d+)\s+skipped=(\d+)/;

export const parseAnsibleLog = (log: string, known: string[] = []): LogProgress => {
  const out: LogProgress = { hosts: {}, order: [], play: '', task: '', finished: false };
  const host = (name: string) => {
    // "10.0.0.1 -> localhost" (delegated) counts for the first name
    const h = name.split(' -> ')[0].trim();
    if (!out.hosts[h]) {
      out.hosts[h] = { host: h, state: 'waiting', task: '', tasks: [], changed: 0 };
      out.order.push(h);
    }
    return out.hosts[h];
  };
  known.forEach(host);
  const lines = log.split('\n');
  let inRecap = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    if (l.startsWith('PLAY RECAP')) {
      inRecap = true;
      out.finished = true;
      continue;
    }
    if (inRecap) {
      const m = RECAP.exec(l);
      if (m && m[1] !== 'localhost') {
        const h = host(m[1]);
        h.recap = { ok: +m[2], changed: +m[3], unreachable: +m[4], failed: +m[5], skipped: +m[6] };
        if (h.recap.unreachable) h.state = 'unreachable';
        else if (h.recap.failed) h.state = 'failed';
        else if (h.state !== 'failed') h.state = h.recap.changed ? 'changed' : h.recap.ok ? 'ok' : 'skipped';
      }
      continue;
    }
    let m = /^PLAY \[(.*)\]/.exec(l);
    if (m) {
      out.play = m[1];
      continue;
    }
    m = /^(TASK|RUNNING HANDLER) \[(.*)\]/.exec(l);
    if (m) {
      out.task = m[2];
      // hosts that are not finished and not failed are now on this task
      Object.values(out.hosts).forEach((h) => {
        if (h.state === 'working' || h.state === 'ok' || h.state === 'changed') h.task = out.task;
      });
      continue;
    }
    m = RESULT.exec(l);
    if (!m) continue;
    const [, kind, name, rest] = m;
    if (name === 'localhost') continue;
    const h = host(name);
    const ignored = (lines[i + 1] ?? '').trim().startsWith('...ignoring');
    h.task = out.task;
    if (out.task && h.tasks[h.tasks.length - 1] !== out.task) h.tasks.push(out.task);
    if (kind === 'fatal' || kind === 'failed' || kind === 'unreachable') {
      if (ignored) continue;
      const unreachable = kind === 'unreachable' || rest.includes('UNREACHABLE');
      h.state = unreachable ? 'unreachable' : 'failed';
      const msg = /"msg":\s*"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? '';
      const err = /"stderr":\s*"((?:[^"\\]|\\.)*)"/.exec(rest)?.[1] ?? '';
      h.error = [msg, err].filter(Boolean).join(': ').replace(/\\n/g, ' ').slice(0, 400) || out.task;
    } else if (h.state !== 'failed' && h.state !== 'unreachable') {
      if (kind === 'changed') h.changed++;
      h.state = 'working';
    }
  }
  if (out.finished) {
    // hosts with no recap line never ran a task
    Object.values(out.hosts).forEach((h) => {
      if (h.state === 'waiting' || h.state === 'working') h.state = h.recap ? 'ok' : 'skipped';
    });
  }
  return out;
};

/** the built-in upgrade playbook's steps, by task name */
export const BUILTIN_STEPS: Record<string, string> = {
  Detect: 'check',
  'Read it': 'check',
  'Pause Patroni (no failover while it restarts)': 'pause',
  'Switchover away from the primary first': 'switchover',
  'Keep the installed version': 'keep',
  'Install the new version': 'install',
  'Put back the saved version': 'putback',
  Restart: 'restart',
  'Wait until healthy': 'health',
  'Resume Patroni': 'resume',
  pgm_result: 'done',
  'Nothing to do here': 'done',
};

export const builtinSteps = (action: 'plan' | 'run' | 'rollback') =>
  action === 'plan'
    ? ['check']
    : action === 'run'
      ? ['keep', 'install', 'restart', 'health']
      : ['putback', 'restart', 'health'];
