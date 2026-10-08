import { FC, useMemo, useState } from 'react';
import { useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import DatabaseServerBox from '@entities/cluster/database-servers-block/ui/DatabaseServerBox.tsx';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import AddIcon from '@mui/icons-material/Add';
import DownloadIcon from '@mui/icons-material/Download';
import { useTranslation } from 'react-i18next';
import { DATABASE_SERVERS_FIELD_NAMES } from '@entities/cluster/database-servers-block/model/const.ts';
import { CLUSTER_FORM_FIELD_NAMES } from '@widgets/cluster-form/model/constants.ts';
import {
  buildHaInventory,
  haInventoryToYaml,
  defaultHaRoles,
  HA_ROLE_ORDER,
  hasRole,
  HaServer,
  parseVmList,
  validateHaLayout,
} from '@shared/lib/haInventory.ts';
import { formServersToHaServers } from '@entities/cluster/database-servers-block/lib/functions.ts';

/**
 * pg_genin: the "Inventory" step. Each card is one VM; its role checkboxes decide which HA inventory
 * groups it lands in. The live preview below is the exact inventory the deployment will use.
 */
const DatabaseServersBlock: FC = () => {
  const { t } = useTranslation('clusters');
  const { control } = useFormContext();

  const { fields, append, remove, replace } = useFieldArray({
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

  const toFormServer = (s: HaServer, index: number) => ({
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_HOSTNAME]: s.hostname ?? '',
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_IP_ADDRESS]: s.ip ?? '',
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_SSH_PORT]: '',
    [DATABASE_SERVERS_FIELD_NAMES.DATABASE_LOCATION]: '',
    // every role set to true/false: a missing key would make the checkbox show the form's initial default
    [DATABASE_SERVERS_FIELD_NAMES.ROLES]: Object.fromEntries(
      HA_ROLE_ORDER.map((r) => [r, hasRole({ roles: s.roles ?? defaultHaRoles(index) }, r)]),
    ),
  });

  // Import: paste the VM list printed by tools/jumbosql-vms.sh (hostname ip roles), replaces the cards
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const closeImport = () => {
    setImportOpen(false);
    setImportErrors([]);
  };
  const doImport = () => {
    const { servers, errors } = parseVmList(importText);
    if (errors.length) {
      setImportErrors(errors);
      return;
    }
    replace(servers.map(toFormServer));
    setImportText('');
    closeImport();
  };

  const addServer = () => append(toFormServer({}, fields.length));

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
        <Stack direction="row" gap="8px" flexWrap="wrap">
          <Button onClick={addServer} startIcon={<AddIcon />}>
            {t('addVirtualMachine')}
          </Button>
          <Button onClick={() => setImportOpen(true)} startIcon={<PlaylistAddIcon />}>
            {t('importVmList')}
          </Button>
        </Stack>
        <Dialog open={importOpen} onClose={closeImport} fullWidth maxWidth="md">
          <DialogTitle>{t('importVmList')}</DialogTitle>
          <DialogContent>
            <Typography variant="body2" color="text.secondary" marginBottom="12px">
              {t('importVmListHelp')}
            </Typography>
            <TextField
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              multiline
              minRows={10}
              fullWidth
              autoFocus
              placeholder={
                'js1-etcd1        192.168.122.41  etcd\njs1-pg1          192.168.122.44  patroni\njs1-haproxy      192.168.122.47  haproxy\njs1-prometheus   192.168.122.50  prometheus'
              }
              slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: '13px' } } }}
            />
            {importErrors.length ? (
              <Alert severity="error" sx={{ mt: 2 }}>
                {importErrors.map((e) => (
                  <div key={e}>{e}</div>
                ))}
              </Alert>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button onClick={closeImport}>{t('cancel', { ns: 'shared' })}</Button>
            <Button variant="contained" onClick={doImport} disabled={!importText.trim()}>
              {t('importVmListApply')}
            </Button>
          </DialogActions>
        </Dialog>
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
