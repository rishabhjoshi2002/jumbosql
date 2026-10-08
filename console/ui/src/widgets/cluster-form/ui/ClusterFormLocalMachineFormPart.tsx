import { FC } from 'react';
import DatabaseServersBlock from '@entities/cluster/database-servers-block';
import AuthenticationMethodFormBlock from '@entities/authentification-method-form-block';

/**
 * pg_genin: deployments to your own machines use the HA inventory step (DatabaseServersBlock), where each VM
 * gets its roles (etcd, PostgreSQL + Patroni, HAProxy, PgBouncer, pgBackRest, Prometheus, Alertmanager, Grafana). The separate
 * Autobase blocks for DCS, VIP and load balancers are replaced by those roles.
 */
const ClusterFormLocalMachineFormPart: FC = () => (
  <>
    <DatabaseServersBlock />
    <AuthenticationMethodFormBlock />
  </>
);

export default ClusterFormLocalMachineFormPart;
