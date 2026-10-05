/**
 * JumboSQL: Keen PostgreSQL HA inventory (HA automation 2.2.0).
 *
 * Every server in the cluster form is a VM with a set of roles. This module turns that list into the
 * HA inventory layout (etcd, Patroni, HAProxy, PgBouncer, pgBackRest, monitoring groups), validates the layout and
 * renders it as YAML for the in-form preview / download. The same object is sent to the API, so what
 * you see in the preview is exactly what the automation runs with.
 */

export const HA_ROLES = Object.freeze({
  ETCD: 'etcd',
  PATRONI: 'patroni',
  HAPROXY: 'haproxy',
  PGBOUNCER: 'pgbouncer',
  BACKREST: 'backrest',
  PROMETHEUS: 'prometheus',
  ALERTMANAGER: 'alertmanager',
  GRAFANA: 'grafana',
});

export type HaRole = (typeof HA_ROLES)[keyof typeof HA_ROLES];

/** `monitoring` is the old combined role (Prometheus + Alertmanager + Grafana on one VM); still accepted. */
export type HaRoles = Partial<Record<HaRole | 'monitoring', boolean>>;

export const MONITORING_ROLES: HaRole[] = [HA_ROLES.PROMETHEUS, HA_ROLES.ALERTMANAGER, HA_ROLES.GRAFANA];

export const hasRole = (s: HaServer, role: HaRole) =>
  !!s.roles?.[role] || (MONITORING_ROLES.includes(role) && !!s.roles?.monitoring);

export const HA_ROLE_ORDER: HaRole[] = [
  HA_ROLES.ETCD,
  HA_ROLES.PATRONI,
  HA_ROLES.HAPROXY,
  HA_ROLES.PGBOUNCER,
  HA_ROLES.BACKREST,
  HA_ROLES.PROMETHEUS,
  HA_ROLES.ALERTMANAGER,
  HA_ROLES.GRAFANA,
];

export const HA_ROLE_LABELS: Record<HaRole, string> = {
  etcd: 'etcd',
  patroni: 'PostgreSQL + Patroni',
  haproxy: 'HAProxy',
  pgbouncer: 'PgBouncer',
  backrest: 'pgBackRest repo',
  prometheus: 'Prometheus',
  alertmanager: 'Alertmanager',
  grafana: 'Grafana',
};

/** Default roles for a new server row: first VM is the util node, the rest are database nodes. */
export const defaultHaRoles = (index: number): HaRoles =>
  index === 0
    ? {
        etcd: true,
        haproxy: true,
        pgbouncer: true,
        backrest: true,
        prometheus: true,
        alertmanager: true,
        grafana: true,
      }
    : { etcd: true, patroni: true };

export interface HaServer {
  hostname?: string;
  ip?: string;
  sshPort?: string | number;
  roles?: HaRoles;
}

type HostVars = Record<string, string | number>;
type Group = { hosts?: Record<string, HostVars>; children?: Record<string, Group> };

export interface HaInventory {
  all: {
    vars: Record<string, string | boolean>;
    children: Record<string, Group>;
  };
}

const octet = (ip: string) => ip.split('.').pop() ?? ip;

const connVars = (s: HaServer): HostVars => (s.sshPort ? { ansible_port: Number(s.sshPort) } : {});

const withRole = (servers: HaServer[], role: HaRole) => servers.filter((s) => s.ip && hasRole(s, role));

/**
 * Builds the HA inventory from the form's server list.
 * `master` / `replica` groups are added as well: the console uses them to count database servers.
 */
export const buildHaInventory = (servers: HaServer[], ansibleUser = 'root'): HaInventory => {
  const etcd = withRole(servers, HA_ROLES.ETCD);
  const patroni = withRole(servers, HA_ROLES.PATRONI);
  const haproxy = withRole(servers, HA_ROLES.HAPROXY);
  const pgbouncer = withRole(servers, HA_ROLES.PGBOUNCER);
  const backrest = withRole(servers, HA_ROLES.BACKREST);
  const prometheus = withRole(servers, HA_ROLES.PROMETHEUS);
  const alertmanager = withRole(servers, HA_ROLES.ALERTMANAGER);
  const grafana = withRole(servers, HA_ROLES.GRAFANA);

  const hosts = (list: HaServer[], extra?: (s: HaServer, i: number) => HostVars) =>
    Object.fromEntries(list.map((s, i) => [s.ip as string, { ...connVars(s), ...(extra ? extra(s, i) : {}) }]));

  const children: Record<string, Group> = {
    etcd_cluster: { hosts: hosts(etcd, (s, i) => ({ etcd_name: `ip${octet(s.ip!)}_etcd${i + 1}` })) },
    patroni_cluster: {
      hosts: hosts(patroni, (s, i) => ({
        patroni_name: `ip${octet(s.ip!)}_pg${i + 1}`,
        ...(s.hostname ? { jumbo_hostname: s.hostname } : {}),
      })),
    },
    backrest_cluster: { hosts: hosts(backrest, (s) => ({ node_jobname: `ip${octet(s.ip!)}_util` })) },
    haproxy_cluster: { hosts: hosts(haproxy) },
    pgbouncer_cluster: { hosts: hosts(pgbouncer) },
  };

  // each monitoring tool may sit on its own VM; pgmonitor_cluster groups whichever are present
  const monGroups: Record<string, Group> = {};
  if (prometheus.length) children.prometheus_cluster = { hosts: hosts(prometheus) };
  if (alertmanager.length) children.alertmanager_cluster = { hosts: hosts(alertmanager) };
  if (grafana.length) children.grafana_cluster = { hosts: hosts(grafana) };
  ['prometheus_cluster', 'alertmanager_cluster', 'grafana_cluster'].forEach((g) => {
    if (children[g]) monGroups[g] = {};
  });
  if (Object.keys(monGroups).length) children.pgmonitor_cluster = { children: monGroups };

  // console bookkeeping (server count / health), ignored by the automation
  children.master = { hosts: hosts(patroni.slice(0, 1), (s) => ({ hostname: s.hostname ?? s.ip! })) };
  children.replica = { hosts: hosts(patroni.slice(1), (s) => ({ hostname: s.hostname ?? s.ip! })) };

  return {
    all: {
      vars: {
        ansible_user: ansibleUser,
        primary_host: haproxy[0]?.ip ?? '',
        primary_port: '{{ haproxy_client_pgport_rw }}',
        standby_cluster: false,
      },
      children,
    },
  };
};

/** Returns a list of layout problems (empty = valid). */
export const validateHaLayout = (servers: HaServer[]): string[] => {
  const errors: string[] = [];
  const count = (role: HaRole) => withRole(servers, role).length;

  const ips = servers.map((s) => s.ip).filter(Boolean);
  const dupes = ips.filter((ip, i) => ips.indexOf(ip) !== i);
  if (dupes.length) errors.push(`The same IP is used twice: ${[...new Set(dupes)].join(', ')}`);

  servers.forEach((s, i) => {
    if (s.ip && !HA_ROLE_ORDER.some((r) => hasRole(s, r))) errors.push(`Server ${i + 1} (${s.ip}) has no role`);
  });

  const etcd = count(HA_ROLES.ETCD);
  if (etcd < 3 || etcd % 2 === 0) errors.push(`etcd needs an odd number of members, at least 3 (now ${etcd})`);
  if (count(HA_ROLES.PATRONI) < 2) errors.push('PostgreSQL + Patroni needs at least 2 servers');
  if (count(HA_ROLES.HAPROXY) < 1) errors.push('HAProxy needs at least 1 server');
  if (count(HA_ROLES.PGBOUNCER) < 1) errors.push('PgBouncer needs at least 1 server');
  if (count(HA_ROLES.BACKREST) !== 1) errors.push('pgBackRest repo must be exactly 1 server');
  const mon = MONITORING_ROLES.map((r) => count(r));
  MONITORING_ROLES.forEach((r, i) => {
    if (mon[i] > 1) errors.push(`${HA_ROLE_LABELS[r]} can be on 1 server at most`);
  });
  if (mon.some((n) => n > 0) && mon.some((n) => n === 0)) {
    errors.push('Prometheus, Alertmanager and Grafana go together: give each one a VM (the same or separate), or none');
  }

  // HAProxy and PostgreSQL both listen on 5432 by default
  withRole(servers, HA_ROLES.HAPROXY)
    .filter((s) => hasRole(s, HA_ROLES.PATRONI))
    .forEach((s) => errors.push(`${s.ip}: HAProxy and PostgreSQL can't share a server (both use port 5432)`));

  return errors;
};

const yamlValue = (v: string | number | boolean) =>
  typeof v === 'string' ? (v === '' || /[{}:#'"\s]/.test(v) ? JSON.stringify(v) : v) : String(v);

const renderGroup = (name: string, group: Group, indent: number, out: string[]) => {
  const pad = '  '.repeat(indent);
  out.push(`${pad}${name}:`);
  if (group.hosts) {
    out.push(`${pad}  hosts:`);
    Object.entries(group.hosts).forEach(([host, vars]) => {
      const entries = Object.entries(vars);
      out.push(`${pad}    ${host}:`);
      entries.forEach(([k, v]) => out.push(`${pad}      ${k}: ${yamlValue(v)}`));
    });
  }
  if (group.children) {
    out.push(`${pad}  children:`);
    Object.entries(group.children).forEach(([child, g]) =>
      Object.keys(g).length ? renderGroup(child, g, indent + 2, out) : out.push(`${pad}    ${child}:`),
    );
  }
};

/** Renders the inventory as YAML (HA groups only, the console's master/replica groups are left out). */
export const haInventoryToYaml = (inventory: HaInventory, clusterName?: string): string => {
  const out = [
    `# Keen PostgreSQL HA inventory generated by JumboSQL${clusterName ? ` for cluster '${clusterName}'` : ''}`,
    '---',
    'all:',
    '  vars:',
  ];
  Object.entries(inventory.all.vars).forEach(([k, v]) => out.push(`    ${k}: ${yamlValue(v)}`));
  out.push('  children:');
  Object.entries(inventory.all.children)
    .filter(([name]) => name !== 'master' && name !== 'replica')
    .forEach(([name, group]) => renderGroup(name, group, 2, out));
  return `${out.join('\n')}\n`;
};

/** Words accepted for each role in a pasted VM list (lower case). */
const ROLE_WORDS: Record<string, HaRole[]> = {
  etcd: [HA_ROLES.ETCD],
  patroni: [HA_ROLES.PATRONI],
  postgres: [HA_ROLES.PATRONI],
  postgresql: [HA_ROLES.PATRONI],
  pg: [HA_ROLES.PATRONI],
  db: [HA_ROLES.PATRONI],
  haproxy: [HA_ROLES.HAPROXY],
  pgbouncer: [HA_ROLES.PGBOUNCER],
  backrest: [HA_ROLES.BACKREST],
  pgbackrest: [HA_ROLES.BACKREST],
  repo: [HA_ROLES.BACKREST],
  prometheus: [HA_ROLES.PROMETHEUS],
  alertmanager: [HA_ROLES.ALERTMANAGER],
  grafana: [HA_ROLES.GRAFANA],
  monitoring: MONITORING_ROLES,
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Parses a VM list, one VM per line: `[hostname] ip [roles]`, roles separated by commas, e.g.
 *   js1-etcd1  192.168.122.41  etcd
 *   js1-util   192.168.122.40  haproxy,pgbouncer,backrest,prometheus,alertmanager,grafana
 * This is the format tools/jumbosql-vms.sh writes. Lines starting with # and empty lines are skipped.
 * A line without roles gets the default roles for its position.
 */
export const parseVmList = (text: string): { servers: HaServer[]; errors: string[] } => {
  const servers: HaServer[] = [];
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, n) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const words = line.split(/\s+/);
    const ipAt = words.findIndex((w) => IPV4.test(w));
    if (ipAt < 0 || ipAt > 1) {
      errors.push(`Line ${n + 1}: expected "[hostname] ip [roles]", got "${raw.trim()}"`);
      return;
    }
    const hostname = ipAt === 1 ? words[0] : undefined;
    const roleText = words.slice(ipAt + 1).join(',');
    let roles: HaRoles = {};
    if (roleText) {
      roleText
        .split(/[,+;/]+/)
        .map((w) => w.trim().toLowerCase())
        .filter(Boolean)
        .forEach((w) => {
          const mapped = ROLE_WORDS[w];
          if (mapped) mapped.forEach((r) => (roles[r] = true));
          else errors.push(`Line ${n + 1}: unknown role "${w}"`);
        });
    } else {
      roles = defaultHaRoles(servers.length);
    }
    servers.push({ hostname, ip: words[ipAt], roles });
  });
  if (!servers.length && !errors.length) errors.push('No VMs found');
  return { servers, errors };
};
