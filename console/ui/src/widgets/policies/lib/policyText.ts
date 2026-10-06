import { Policy } from '@shared/api/api/access.ts';

/** Plain-language summaries of a policy, for the policy list. */

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const whoText = (p: Policy) => {
  const s = p.subjects ?? {};
  if (s.everyone) return 'Everyone';
  const parts: string[] = [];
  if (s.users?.length) parts.push(`users ${s.users.join(', ')}`);
  const attrs = Object.entries(s.attributes ?? {}).map(([k, v]) => `${k} = ${v.join(' or ')}`);
  if (attrs.length) parts.push(attrs.join(' and '));
  return parts.join('; ') || 'nobody';
};

export const whereText = (p: Policy) => {
  const r = p.resources ?? {};
  const parts: string[] = [];
  if (r.clusters?.length) parts.push(`clusters ${r.clusters.join(', ')}`);
  if (r.environments?.length) parts.push(`environment ${r.environments.join(' / ')}`);
  if (r.projects?.length) parts.push(`project ${r.projects.join(' / ')}`);
  return parts.length ? parts.join(', ') : 'all clusters';
};

export const dataText = (p: Policy) => {
  const d = p.data ?? {};
  const parts: string[] = [];
  if (d.databases?.length) parts.push(`databases ${d.databases.join(', ')}`);
  if (d.schemas?.length) parts.push(`schemas ${d.schemas.join(', ')}`);
  if (d.tables?.length) parts.push(`tables ${d.tables.join(', ')}`);
  if (d.hidden_columns?.length) parts.push(`hides ${d.hidden_columns.join(', ')}`);
  if (d.max_rows) parts.push(`max ${d.max_rows} rows`);
  if (d.timeout_seconds) parts.push(`${d.timeout_seconds}s limit`);
  return parts.join(' · ');
};

export const whenText = (p: Policy) => {
  const c = p.conditions ?? {};
  const parts: string[] = [];
  if (c.ip_ranges?.length) parts.push(`from ${c.ip_ranges.join(', ')}`);
  if (c.weekdays?.length) {
    const days = [...c.weekdays].sort();
    const isRange = days.every((d, i) => i === 0 || d === days[i - 1] + 1);
    parts.push(
      isRange && days.length > 2
        ? `${WEEKDAYS[days[0] - 1]}–${WEEKDAYS[days[days.length - 1] - 1]}`
        : days.map((d) => WEEKDAYS[d - 1]).join(', '),
    );
  }
  if (c.hours) parts.push(c.hours);
  if ((c.weekdays?.length || c.hours) && c.timezone) parts.push(`(${c.timezone})`);
  return parts.join(' ');
};

export const emptyPolicy = (): Policy => ({
  name: '',
  description: '',
  effect: 'allow',
  enabled: true,
  subjects: { attributes: {} },
  permissions: [],
  resources: {},
  data: {},
  conditions: {},
});

/** Removes empty lists / objects so the stored policy stays readable. */
export const tidyPolicy = (p: Policy): Policy => {
  const list = (v?: string[]) =>
    v && v.map((x) => x.trim()).filter(Boolean).length ? v.map((x) => x.trim()).filter(Boolean) : undefined;
  const attrs = Object.fromEntries(
    Object.entries(p.subjects?.attributes ?? {})
      .map(([k, v]) => [k.trim().toLowerCase(), (v ?? []).map((x) => x.trim()).filter(Boolean)] as const)
      .filter(([k, v]) => k && v.length),
  );
  return {
    ...p,
    name: p.name.trim(),
    description: p.description?.trim() || undefined,
    subjects: {
      everyone: p.subjects?.everyone || undefined,
      users: list(p.subjects?.users),
      attributes: Object.keys(attrs).length ? attrs : undefined,
    },
    resources: {
      clusters: list(p.resources?.clusters),
      environments: list(p.resources?.environments),
      projects: list(p.resources?.projects),
    },
    data: {
      databases: list(p.data?.databases),
      schemas: list(p.data?.schemas),
      tables: list(p.data?.tables),
      hidden_columns: list(p.data?.hidden_columns),
      max_rows: p.data?.max_rows || undefined,
      timeout_seconds: p.data?.timeout_seconds || undefined,
    },
    conditions: {
      ip_ranges: list(p.conditions?.ip_ranges),
      weekdays: p.conditions?.weekdays?.length ? [...p.conditions.weekdays].sort() : undefined,
      hours: p.conditions?.hours?.trim() || undefined,
      timezone:
        (p.conditions?.weekdays?.length || p.conditions?.hours) && p.conditions?.timezone
          ? p.conditions.timezone
          : undefined,
    },
  };
};

/** Permission groups for the editor. */
export const PERMISSION_GROUPS: { label: string; perms: string[] }[] = [
  { label: 'Clusters', perms: ['clusters.view', 'clusters.manage'] },
  { label: 'Patroni', perms: ['patroni.read', 'patroni.manage'] },
  { label: 'SQL editor', perms: ['sql.read', 'sql.write', 'sql.admin', 'sql.stats'] },
  { label: 'Logs and monitoring', perms: ['logs.view', 'observability.manage'] },
  { label: 'Administration', perms: ['settings.manage', 'users.manage', 'policies.manage', 'audit.view'] },
];
