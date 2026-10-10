/**
 * pg_genie: Keen PostgreSQL HA inventory (HA automation 2.2.0).
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
  MONITORING: 'monitoring',
});

export type HaRole = (typeof HA_ROLES)[keyof typeof HA_ROLES];

/**
 * Monitoring = Prometheus + Alertmanager + Grafana on ONE VM: the HA automation wires them together through
 * localhost (Grafana's data source, Prometheus' Alertmanager target). Forms saved by the version that had three
 * separate monitoring roles still load; any of those three counts as Monitoring.
 */
export type HaRoles = Partial<Record<HaRole | 'prometheus' | 'alertmanager' | 'grafana', boolean>>;

const OLD_MONITORING_KEYS = ['prometheus', 'alertmanager', 'grafana'] as const;

export const hasRole = (s: HaServer, role: HaRole) =>
  !!s.roles?.[role] || (role === HA_ROLES.MONITORING && OLD_MONITORING_KEYS.some((k) => !!s.roles?.[k]));

export const HA_ROLE_ORDER: HaRole[] = [
  HA_ROLES.ETCD,
  HA_ROLES.PATRONI,
  HA_ROLES.HAPROXY,
  HA_ROLES.PGBOUNCER,
  HA_ROLES.BACKREST,
  HA_ROLES.MONITORING,
];

export const HA_ROLE_LABELS: Record<HaRole, string> = {
  etcd: 'etcd',
  patroni: 'PostgreSQL + Patroni',
  haproxy: 'HAProxy',
  pgbouncer: 'PgBouncer',
  backrest: 'pgBackRest repo',
  monitoring: 'Monitoring (Prometheus, Alertmanager, Grafana)',
};

/** Default roles for a new server row: first VM is the util node, the rest are database nodes. */
export const defaultHaRoles = (index: number): HaRoles =>
  index === 0
    ? { etcd: true, haproxy: true, pgbouncer: true, backrest: true, monitoring: true }
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
  const monitoring = withRole(servers, HA_ROLES.MONITORING);

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

  // the Monitoring VM runs all three tools (they reach each other on localhost)
  if (monitoring.length) {
    children.prometheus_cluster = { hosts: hosts(monitoring) };
    children.alertmanager_cluster = { hosts: hosts(monitoring) };
    children.grafana_cluster = { hosts: hosts(monitoring) };
    children.pgmonitor_cluster = {
      children: { prometheus_cluster: {}, alertmanager_cluster: {}, grafana_cluster: {} },
    };
  }

  // every host needs a name variable: the HA preflight crashes on a host with no etcd_name / patroni_name /
  // node_jobname, which happens when HAProxy, PgBouncer or Monitoring has a VM of its own
  const NAME_VARS = ['etcd_name', 'patroni_name', 'node_jobname'];
  const SHORT: Record<string, string> = {
    haproxy_cluster: 'haproxy',
    pgbouncer_cluster: 'pgbouncer',
    prometheus_cluster: 'monitoring',
  };
  const named = new Set(
    Object.values(children).flatMap((g) =>
      Object.entries(g.hosts ?? {})
        .filter(([, v]) => NAME_VARS.some((k) => v[k]))
        .map(([ip]) => ip),
    ),
  );
  Object.entries(SHORT).forEach(([group, short]) => {
    Object.keys(children[group]?.hosts ?? {}).forEach((ip) => {
      if (named.has(ip)) return;
      children[group].hosts![ip] = { ...children[group].hosts![ip], node_jobname: `ip${octet(ip)}_${short}` };
      named.add(ip);
    });
  });

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
  if (count(HA_ROLES.MONITORING) > 1)
    errors.push(
      'Monitoring (Prometheus, Alertmanager, Grafana) can only be on one VM: the automation connects them through localhost',
    );

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
    `# Keen PostgreSQL HA inventory generated by pg_genie${clusterName ? ` for cluster '${clusterName}'` : ''}`,
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
  monitoring: [HA_ROLES.MONITORING],
  monitor: [HA_ROLES.MONITORING],
  prometheus: [HA_ROLES.MONITORING],
  alertmanager: [HA_ROLES.MONITORING],
  grafana: [HA_ROLES.MONITORING],
};

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/**
 * Parses a VM list, one VM per line: `[hostname] ip [roles]`, roles separated by commas, e.g.
 *   js1-etcd1  192.168.122.41  etcd
 *   js1-proxy  192.168.122.40  haproxy,pgbouncer
 *   js1-monitor 192.168.122.48 monitoring
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
