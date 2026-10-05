import { UseFieldArrayRemove } from 'react-hook-form';
import { CpaRoles } from '@shared/lib/cpaInventory.ts';
import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';

export interface DatabaseServerBlockProps {
  index: number;
  remove?: UseFieldArrayRemove;
}

export interface DatabaseServerBlockValues {
  [DATABASE_SERVERS_FIELD_NAMES.IS_CLUSTER_EXISTS]?: boolean;
  [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]: {
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME]: string;
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS]: string;
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT]: string;
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_LOCATION]: string;
    [DATABASE_SERVERS_FIELD_NAMES.IS_POSTGRESQL_EXISTS]?: boolean;
    [DATABASE_SERVERS_FIELD_NAMES.ROLES]?: CpaRoles;
  }[];
}
