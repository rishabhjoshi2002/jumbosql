import { FC, useMemo } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import DatabaseServerBox from '@entities/cluster/database-servers-block/ui/DatabaseServerBox.tsx';
import { Alert, Box, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DownloadIcon from '@mui/icons-material/Download';
import { useTranslation } from 'react-i18next';
import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';
import { CLUSTER_FORM_FIELD_NAMES } from '@widgets/cluster-form/model/constants.ts';
import { buildHaInventory, haInventoryToYaml, defaultHaRoles, validateHaLayout } from '@shared/lib/haInventory.ts';
import { formServersToHaServers } from '@entities/cluster/database-servers-block/lib/functions.ts';

/**
 * JumboSQL: the "Inventory" step. Each card is one VM; its role checkboxes decide which HA inventory
 * groups it lands in. The live preview below is the exact inventory the deployment will use.
 */
const DatabaseServersBlock: FC = () => {
  const { t } = useTranslation('clusters');
  const { control } = useFormContext();

  const { fields, append, remove } = useFieldArray({
    control,
    name: DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS,
  });

  const watchServers = useWatch({ name: DATABASE_SERVERS_FIELD_NAMES.DATABASE_SERVERS });
  const watchClusterName = useWatch({ name: CLUSTER_FORM_FIELD_NAMES.CLUSTER_NAME });

  const haServers = useMemo(() => formServersToHaServers(watchServers ?? []), [watchServers]);
  const layoutErrors = useMemo(() => (haServers.some((s) => s.ip) ? validateHaLayout(haServers) : []), [haServers]);
  const yaml = useMemo(
    () => haInventoryToYaml(buildHaInventory(haServers), watchClusterName),
    [haServers, watchClusterName],
  );

  const removeServer = (index: number) => () => remove(index);

  const addServer = () =>
    append({
      [DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME]: '',
      [DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS]: '',
      [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT]: '',
      [DATABASE_SERVERS_FIELD_NAMES.DATABASE_LOCATION]: '',
      [DATABASE_SERVERS_FIELD_NAMES.ROLES]: defaultHaRoles(fields.length),
    });

  const downloadInventory = () => {
    const url = URL.createObjectURL(new Blob([yaml], { type: 'text/yaml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${watchClusterName || 'cluster'}.inventory.yml`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Box>
      <Typography fontWeight="bold" marginBottom="4px">
        {t('haInventory')}
      </Typography>
      <Typography variant="caption" color="textSecondary" component="p" marginBottom="12px">
        {t('haInventoryHelp')}
      </Typography>
      <Stack direction="column" gap="16px" justifyContent="center" alignItems="flex-start">
        <Box display="flex" gap="16px" flexWrap="wrap" justifyContent="flex-start" alignItems="flex-start">
          {fields.map((field, index) => (
            <DatabaseServerBox
              key={field.id}
              index={index}
              {...(index !== 0 ? { remove: removeServer(index) } : {})} // removing entity such way is required to avoid bugs with a wrong element removed
            />
          ))}
        </Box>
        <Button onClick={addServer} startIcon={<AddIcon />}>
          {t('addVirtualMachine')}
        </Button>
        {layoutErrors.length ? (
          <Alert severity="warning" sx={{ width: '100%' }}>
            {layoutErrors.map((e) => (
              <div key={e}>{e}</div>
            ))}
          </Alert>
        ) : null}
        <Box width="100%">
          <Stack direction="row" alignItems="center" justifyContent="space-between" marginBottom="4px">
            <Typography variant="body2" fontWeight="bold">
              {t('haInventoryPreview')}
            </Typography>
            <Button size="small" startIcon={<DownloadIcon />} onClick={downloadInventory}>
              {t('downloadInventory')}
            </Button>
          </Stack>
          <Box
            component="pre"
            data-testid="ha-inventory-preview"
            sx={{
              margin: 0,
              padding: '12px',
              maxHeight: '320px',
              overflow: 'auto',
              fontSize: '12px',
              borderRadius: '4px',
              backgroundColor: 'action.hover',
              fontFamily: 'monospace',
            }}>
            {yaml}
          </Box>
        </Box>
      </Stack>
    </Box>
  );
};

export default DatabaseServersBlock;
