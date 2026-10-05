import * as yup from 'yup';
import { CLUSTER_FORM_FIELD_NAMES } from '@widgets/cluster-form/model/constants.ts';
import { PROVIDERS } from '@shared/config/constants.ts';
import ipRegex from 'ip-regex';
import { TFunction } from 'i18next';
import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';
import { validateCpaLayout } from '@shared/lib/cpaInventory.ts';
import { formServersToCpaServers } from '@entities/cluster/database-servers-block/lib/functions.ts';

export const DatabaseServersBlockSchema = (t: TFunction) =>
  yup.object({
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS]: yup
      .mixed()
      .when(CLUSTER_FORM_FIELD_NAMES.PROVIDER, ([provider], schema) =>
        provider?.code === PROVIDERS.LOCAL
          ? yup.array(
              yup.object({
                [DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME]: yup
                  .string()
                  .required(t('requiredField', { ns: 'validation' })),
                [DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS]: yup
                  .string()
                  .required(t('requiredField', { ns: 'validation' }))
                  .test('should be a correct IP', t('shouldBeACorrectV4Ip', { ns: 'validation' }), (value) =>
                    ipRegex.v4({ exact: true }).test(value),
                  ),
                [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT]: yup
                  .string()
                  .test('only numbers', t('onlyNumbers', { ns: 'validation' }), (value) =>
                    value ? /^\d+$/.test(value) : true,
                  )
                  .test('valid ssh port', t('sshPortRange', { ns: 'validation' }), (value) =>
                    value ? Number(value) >= 1 && Number(value) <= 65535 : true,
                  ),
                [DATABASE_SERVERS_FIELD_NAMES.DATABASE_LOCATION]: yup.string(),
              }),
            )
              // JumboSQL: the roles must add up to a valid CPA layout (odd etcd, 2+ Patroni, one pgBackRest repo, ...)
              .test('valid CPA layout', (value, ctx) => {
                const problems = validateCpaLayout(formServersToCpaServers(value ?? []));
                return problems.length ? ctx.createError({ message: problems.join('; ') }) : true;
              })
          : schema.notRequired(),
      ),
  });
