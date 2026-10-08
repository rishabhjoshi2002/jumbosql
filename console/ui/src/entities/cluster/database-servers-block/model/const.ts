export const DATABASE_SERVERS_FIELD_NAMES = Object.freeze({
  IS_CLUSTER_EXISTS: 'databaseServerExistingCluster',
  DATABASE_SERVERS: 'databaseServers',
  DATABASE_HOSTNAME: 'databaseServerHostname',
  DATABASE_IP_ADDRESS: 'databaseServerIpAddress',
  DATABASE_SSH_PORT: 'databaseServerSshPort',
  DATABASE_LOCATION: 'databaseServerLocation',
  IS_POSTGRESQL_EXISTS: 'databaseServerIsPostgreSQLExist',
  ROLES: 'roles', // pg_genin: HA roles of this VM (etcd, patroni, haproxy, pgbouncer, backrest, prometheus, alertmanager, grafana)
});
