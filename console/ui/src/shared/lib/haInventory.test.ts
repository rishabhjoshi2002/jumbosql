import { describe, expect, it } from 'vitest';
import {
  buildHaInventory,
  haInventoryToYaml,
  HaServer,
  defaultHaRoles,
  parseVmList,
  validateHaLayout,
} from './haInventory';

// The layout from the lab: one util VM + two DB VMs ("combined" layout)
const combined: HaServer[] = [
  { hostname: 'util1', ip: '192.168.122.27', roles: defaultHaRoles(0) },
  { hostname: 'db1', ip: '192.168.122.24', roles: defaultHaRoles(1) },
  { hostname: 'db2', ip: '192.168.122.25', roles: defaultHaRoles(2) },
];

describe('buildHaInventory', () => {
  it('puts each VM in the HA groups of its roles', () => {
    const inv = buildHaInventory(combined);
    const c = inv.all.children;

    expect(Object.keys(c.etcd_cluster.hosts!)).toEqual(['192.168.122.27', '192.168.122.24', '192.168.122.25']);
    expect(c.etcd_cluster.hosts!['192.168.122.24']).toEqual({ etcd_name: 'ip24_etcd2' });
    expect(c.patroni_cluster.hosts).toEqual({
      '192.168.122.24': { patroni_name: 'ip24_pg1', jumbo_hostname: 'db1' },
      '192.168.122.25': { patroni_name: 'ip25_pg2', jumbo_hostname: 'db2' },
    });
    expect(c.backrest_cluster.hosts).toEqual({ '192.168.122.27': { node_jobname: 'ip27_util' } });
    for (const g of ['haproxy_cluster', 'pgbouncer_cluster', 'prometheus_cluster', 'grafana_cluster']) {
      expect(Object.keys(c[g].hosts!)).toEqual(['192.168.122.27']);
    }
    expect(inv.all.vars.primary_host).toBe('192.168.122.27');
  });

  it('adds master/replica for the console from the Patroni nodes', () => {
    const c = buildHaInventory(combined).all.children;
    expect(Object.keys(c.master.hosts!)).toEqual(['192.168.122.24']);
    expect(Object.keys(c.replica.hosts!)).toEqual(['192.168.122.25']);
  });

  it('leaves monitoring groups out when no VM has the role', () => {
    const noMon = combined.map((s) => ({
      ...s,
      roles: { ...s.roles, prometheus: false, alertmanager: false, grafana: false },
    }));
    const c = buildHaInventory(noMon).all.children;
    expect(c.prometheus_cluster).toBeUndefined();
    expect(c.pgmonitor_cluster).toBeUndefined();
  });

  it('passes a custom SSH port as ansible_port', () => {
    const servers = combined.map((s, i) => (i === 1 ? { ...s, sshPort: '2222' } : s));
    expect(buildHaInventory(servers).all.children.patroni_cluster.hosts!['192.168.122.24'].ansible_port).toBe(2222);
  });
});

describe('validateHaLayout', () => {
  it('accepts the combined layout', () => {
    expect(validateHaLayout(combined)).toEqual([]);
  });

  it('accepts the split layout (3 etcd VMs, 2 DB VMs, 1 util VM)', () => {
    const split: HaServer[] = [
      { ip: '10.0.0.20', roles: { etcd: true } },
      { ip: '10.0.0.22', roles: { etcd: true } },
      { ip: '10.0.0.23', roles: { etcd: true } },
      { ip: '10.0.0.24', roles: { patroni: true } },
      { ip: '10.0.0.25', roles: { patroni: true } },
      { ip: '10.0.0.27', roles: { haproxy: true, pgbouncer: true, backrest: true, monitoring: true } },
    ];
    expect(validateHaLayout(split)).toEqual([]);
  });

  it('rejects an even etcd count, a single Patroni node and HAProxy on a DB node', () => {
    const bad: HaServer[] = [
      { ip: '10.0.0.1', roles: { etcd: true, patroni: true, haproxy: true, pgbouncer: true, backrest: true } },
      { ip: '10.0.0.2', roles: { etcd: true } },
    ];
    const errors = validateHaLayout(bad).join('\n');
    expect(errors).toMatch(/odd number/);
    expect(errors).toMatch(/at least 2/);
    expect(errors).toMatch(/can't share a server/);
  });

  it('rejects duplicate IPs, VMs without a role and two pgBackRest repos', () => {
    const bad: HaServer[] = [
      ...combined,
      { ip: '192.168.122.24', roles: { backrest: true } },
      { ip: '192.168.122.30', roles: {} },
    ];
    const errors = validateHaLayout(bad).join('\n');
    expect(errors).toMatch(/same IP/);
    expect(errors).toMatch(/has no role/);
    expect(errors).toMatch(/exactly 1 server/);
  });
});

describe('haInventoryToYaml', () => {
  it('renders HA groups only, with quoted templates', () => {
    const yaml = haInventoryToYaml(buildHaInventory(combined), 'keen-ab1');
    expect(yaml).toContain("for cluster 'keen-ab1'");
    expect(yaml).toContain('    primary_port: "{{ haproxy_client_pgport_rw }}"');
    expect(yaml).toContain(
      '    patroni_cluster:\n      hosts:\n        192.168.122.24:\n          patroni_name: ip24_pg1',
    );
    expect(yaml).toContain('    pgmonitor_cluster:\n      children:\n        prometheus_cluster:');
    expect(yaml).not.toMatch(/^\s+master:/m);
    expect(yaml).not.toMatch(/^\s+replica:/m);
  });
});

// One VM per role, as made by `jumbosql-vms.sh --layout split`
const separate: HaServer[] = [
  { hostname: 'js1-etcd1', ip: '10.0.0.20', roles: { etcd: true } },
  { hostname: 'js1-etcd2', ip: '10.0.0.21', roles: { etcd: true } },
  { hostname: 'js1-etcd3', ip: '10.0.0.22', roles: { etcd: true } },
  { hostname: 'js1-pg1', ip: '10.0.0.23', roles: { patroni: true } },
  { hostname: 'js1-pg2', ip: '10.0.0.24', roles: { patroni: true } },
  { hostname: 'js1-pg3', ip: '10.0.0.25', roles: { patroni: true } },
  { hostname: 'js1-haproxy', ip: '10.0.0.26', roles: { haproxy: true } },
  { hostname: 'js1-pgbouncer', ip: '10.0.0.27', roles: { pgbouncer: true } },
  { hostname: 'js1-backrest', ip: '10.0.0.28', roles: { backrest: true } },
  { hostname: 'js1-prometheus', ip: '10.0.0.29', roles: { prometheus: true } },
  { hostname: 'js1-alertmanager', ip: '10.0.0.30', roles: { alertmanager: true } },
  { hostname: 'js1-grafana', ip: '10.0.0.31', roles: { grafana: true } },
];

describe('separate VM for every role', () => {
  it('is a valid layout', () => {
    expect(validateHaLayout(separate)).toEqual([]);
  });

  it('puts each monitoring tool on its own VM, grouped under pgmonitor_cluster', () => {
    const c = buildHaInventory(separate).all.children;
    expect(Object.keys(c.prometheus_cluster.hosts!)).toEqual(['10.0.0.29']);
    expect(Object.keys(c.alertmanager_cluster.hosts!)).toEqual(['10.0.0.30']);
    expect(Object.keys(c.grafana_cluster.hosts!)).toEqual(['10.0.0.31']);
    expect(Object.keys(c.pgmonitor_cluster.children!)).toEqual([
      'prometheus_cluster',
      'alertmanager_cluster',
      'grafana_cluster',
    ]);
    expect(Object.keys(c.haproxy_cluster.hosts!)).toEqual(['10.0.0.26']);
    expect(Object.keys(c.pgbouncer_cluster.hosts!)).toEqual(['10.0.0.27']);
    expect(c.backrest_cluster.hosts).toEqual({ '10.0.0.28': { node_jobname: 'ip28_util' } });
    expect(Object.keys(c.patroni_cluster.hosts!)).toHaveLength(3);
  });

  it('rejects an incomplete monitoring set', () => {
    const partial = separate.filter((s) => s.hostname !== 'js1-alertmanager');
    expect(validateHaLayout(partial).join('\n')).toMatch(/go together/);
  });

  it('still reads the old combined Monitoring role as all three tools', () => {
    const legacy: HaServer[] = combined.map((s, i) =>
      i === 0 ? { ...s, roles: { etcd: true, haproxy: true, pgbouncer: true, backrest: true, monitoring: true } } : s,
    );
    expect(validateHaLayout(legacy)).toEqual([]);
    const c = buildHaInventory(legacy).all.children;
    expect(Object.keys(c.alertmanager_cluster.hosts!)).toEqual(['192.168.122.27']);
  });
});

describe('parseVmList', () => {
  it('reads the list written by jumbosql-vms.sh', () => {
    const text = separate.map((s) => `${s.hostname}  ${s.ip}  ${Object.keys(s.roles!).join(',')}`).join('\n');
    const { servers, errors } = parseVmList(`# set js1\n${text}\n`);
    expect(errors).toEqual([]);
    expect(servers).toEqual(separate);
  });

  it('accepts bare IPs (default roles), aliases and reports bad lines', () => {
    const { servers, errors } = parseVmList(
      '192.168.122.40\ndb1 192.168.122.41 postgres,etcd\nutil 192.168.122.42 monitoring+repo\nnot-an-ip\nx 10.0.0.1 web',
    );
    expect(servers[0]).toEqual({ hostname: undefined, ip: '192.168.122.40', roles: defaultHaRoles(0) });
    expect(servers[1].roles).toEqual({ patroni: true, etcd: true });
    expect(servers[2].roles).toEqual({ prometheus: true, alertmanager: true, grafana: true, backrest: true });
    expect(errors.join('\n')).toMatch(/Line 4/);
    expect(errors.join('\n')).toMatch(/unknown role "web"/);
  });
});
