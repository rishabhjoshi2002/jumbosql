import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';
import { CpaRoles, CpaServer } from '@shared/lib/cpaInventory.ts';

type FormServer = Record<string, unknown>;

/** Maps the form's server rows to the shape used by the CPA inventory builder. */
export const formServersToCpaServers = (servers: FormServer[]): CpaServer[] =>
  (servers ?? []).map((s) => ({
    hostname: (s?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME] as string) || undefined,
    ip: ((s?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS] as string) || '').trim() || undefined,
    sshPort: (s?.[DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT] as string) || undefined,
    roles: (s?.[DATABASE_SERVERS_FIELD_NAMES.ROLES] as CpaRoles) ?? {},
  }));
