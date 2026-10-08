// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

describe('cluster form backup defaults', () => {
  it('uses Autobase start hour and retention defaults in expert mode', async () => {
    localStorage.setItem('isExpertMode', 'true');
    vi.resetModules();

    const { getClusterFormDefaultValues } = await import('@widgets/cluster-form/model/constants.ts');
    const { BACKUP_DEFAULTS, BACKUP_METHODS } = await import(
      '@entities/cluster/expert-mode/backups-block/model/const.ts'
    );
    const values = getClusterFormDefaultValues();

    expect(values.backupStartTime).toBe(3);
    expect(values.backupRetention).toBe(30);
    expect(BACKUP_DEFAULTS.RETENTION_BY_METHOD[BACKUP_METHODS.WAL_G]).toBe(4);
  });
});

// pg_genin: getLocalMachineEnvs sends the HA inventory built from the VM roles in the inventory step
describe('getLocalMachineEnvs', () => {
  const values = (expert: boolean) => ({
    authenticationMethod: 'ssh_key',
    isUseDefinedSecret: false,
    USERNAME: 'root',
    // the expert-mode DCS / load balancer fields must be ignored: roles decide everything
    ...(expert
      ? {
          isHaproxyEnabled: true,
          loadBalancerDatabases: [{ loadBalancerDatabasesIpAddress: '10.0.1.1' }],
          dcsDatabases: [{ dcsDatabaseIpAddress: '10.0.2.1' }],
        }
      : {}),
    databaseServers: [
      {
        databaseServerHostname: 'util-1',
        databaseServerIpAddress: '10.0.0.10',
        databaseServerSshPort: '',
        roles: { etcd: true, haproxy: true, pgbouncer: true, backrest: true, monitoring: true },
      },
      {
        databaseServerHostname: 'db-1',
        databaseServerIpAddress: '10.0.0.1',
        databaseServerSshPort: '2222',
        roles: { etcd: true, patroni: true },
      },
      {
        databaseServerHostname: 'db-2',
        databaseServerIpAddress: '10.0.0.2',
        databaseServerSshPort: '2202',
        roles: { etcd: true, patroni: true },
      },
    ],
  });

  it.each([false, true])('builds the HA groups from the roles (expert mode: %s)', async (expert) => {
    localStorage.setItem('isExpertMode', String(expert));
    vi.resetModules();

    const { getLocalMachineEnvs } = await import('@shared/lib/clusterValuesTransformFunctions.ts');
    const inventory = getLocalMachineEnvs(values(expert) as never).ANSIBLE_INVENTORY_JSON.all.children;

    expect(Object.keys(inventory.etcd_cluster.hosts)).toEqual(['10.0.0.10', '10.0.0.1', '10.0.0.2']);
    expect(Object.keys(inventory.patroni_cluster.hosts)).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(Object.keys(inventory.haproxy_cluster.hosts)).toEqual(['10.0.0.10']);
    expect(inventory.balancers).toBeUndefined();
    // console bookkeeping: first Patroni node = master
    expect(Object.keys(inventory.master.hosts)).toEqual(['10.0.0.1']);
    expect(Object.keys(inventory.replica.hosts)).toEqual(['10.0.0.2']);
  });

  it('maps per-host ssh port to ansible_port', async () => {
    localStorage.setItem('isExpertMode', 'false');
    vi.resetModules();

    const { getLocalMachineEnvs } = await import('@shared/lib/clusterValuesTransformFunctions.ts');
    const inventory = getLocalMachineEnvs(values(false) as never).ANSIBLE_INVENTORY_JSON.all.children;

    expect(inventory.patroni_cluster.hosts['10.0.0.1'].ansible_port).toBe(2222);
    expect(inventory.etcd_cluster.hosts['10.0.0.2'].ansible_port).toBe(2202);
    expect(inventory.etcd_cluster.hosts['10.0.0.10'].ansible_port).toBeUndefined();
  });
});
