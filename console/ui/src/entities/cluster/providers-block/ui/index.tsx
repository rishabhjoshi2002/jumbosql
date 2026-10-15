import { FC } from 'react';
import { Box, Stack, Tooltip, Typography, useTheme } from '@mui/material';
import { Controller, useFormContext } from 'react-hook-form';
import { CLUSTER_FORM_FIELD_NAMES } from '@widgets/cluster-form/model/constants.ts';
import { useTranslation } from 'react-i18next';
import { useNameIconProvidersMap } from '@entities/cluster/cloud-region-block/lib/hooks.tsx';
import ErrorOutlineOutlinedIcon from '@mui/icons-material/ErrorOutlineOutlined';
import ServersIcon from '@assets/serversIcon.svg?react';
import { ProvidersBlockProps } from '@entities/cluster/providers-block/model/types.ts';
import { PROVIDERS } from '@shared/config/constants.ts';
import ClusterFormCloudProviderBox from '@entities/cluster/providers-block/ui/ClusterFormCloudProviderBox.tsx';
import { INSTANCES_BLOCK_FIELD_NAMES } from '@entities/cluster/instances-block/model/const.ts';
import { STORAGE_BLOCK_FIELDS } from '@entities/cluster/storage-block/model/const.ts';
import { BACKUPS_BLOCK_FIELD_NAMES } from '@entities/cluster/expert-mode/backups-block/model/const.ts';
import { getDefaultCloudRegionSelection } from '@shared/lib/defaultCloudRegion.ts';

// what the form needs from a provider (the API sends more)
type ProviderOption = ProvidersBlockProps['providers'][number] & {
  instance_types?: Record<string, unknown[]>;
  volumes?: { is_default?: boolean; min_size?: number }[];
  cloud_regions?: { code?: string; datacenters?: { code?: string }[] | null }[] | null;
};
const defaultVolume = (p: ProviderOption) => p?.volumes?.find((volume) => volume?.is_default);

const ClusterFormProvidersBlock: FC<ProvidersBlockProps> = ({ providers }) => {
  const { t } = useTranslation('clusters');
  const { control, reset } = useFormContext();
  const theme = useTheme();

  const nameIconProvidersMap = useNameIconProvidersMap();

  const handleProviderChange = (value: ProviderOption) => () => {
    const { regionCode, datacenter } = getDefaultCloudRegionSelection(value);
    reset((values) => ({
      ...values,
      [CLUSTER_FORM_FIELD_NAMES.PROVIDER]: value,
      [CLUSTER_FORM_FIELD_NAMES.REGION]: regionCode,
      [CLUSTER_FORM_FIELD_NAMES.REGION_CONFIG]: datacenter,
      [INSTANCES_BLOCK_FIELD_NAMES.INSTANCE_TYPE]: 'small',
      [CLUSTER_FORM_FIELD_NAMES.INSTANCE_CONFIG]: value?.instance_types?.small?.[0],
      [STORAGE_BLOCK_FIELDS.STORAGE_AMOUNT]:
        (defaultVolume(value)?.min_size ?? 0) < 100 ? 100 : defaultVolume(value)?.min_size,
      [BACKUPS_BLOCK_FIELD_NAMES.IS_BACKUPS_ENABLED]: value.code !== PROVIDERS.LOCAL,
    }));
  };

  return (
    <Box>
      <Typography fontWeight="bold" marginBottom="8px">
        {t('selectDeploymentDestination')}
      </Typography>
      <Controller
        control={control}
        name={CLUSTER_FORM_FIELD_NAMES.PROVIDER}
        render={({ field: { value } }) => (
          <Stack direction="row" spacing={2}>
            {providers.map((provider: ProviderOption) => (
              <ClusterFormCloudProviderBox
                key={provider.code}
                isActive={value?.code === provider.code}
                onClick={handleProviderChange(provider)}
                name={provider.description}>
                <img
                  src={(nameIconProvidersMap as Record<string, string>)[provider.code ?? '']}
                  width="100%"
                  alt={provider.description}
                />
              </ClusterFormCloudProviderBox>
            ))}
            <ClusterFormCloudProviderBox
              isActive={value?.code === PROVIDERS.LOCAL}
              onClick={handleProviderChange({ code: PROVIDERS.LOCAL })}>
              <Box>
                <Tooltip title={t('yourOwnMachinesTooltip')} sx={{ position: 'absolute', right: '4px', top: '4px' }}>
                  <ErrorOutlineOutlinedIcon fontSize="small" />
                </Tooltip>
                <Stack direction="row" alignItems="center" gap={0.5}>
                  <ServersIcon width="24px" height="24px" style={{ fill: theme.palette.text.primary }} />
                  <Stack direction="column" gap={0}>
                    <Typography fontWeight="bold" lineHeight={1}>
                      {t('yourOwn')}
                    </Typography>
                    <Typography fontWeight="bold" color={theme.palette.primary.main} lineHeight={1}>
                      {t('machines')}
                    </Typography>
                  </Stack>
                </Stack>
              </Box>
            </ClusterFormCloudProviderBox>
          </Stack>
        )}
      />
    </Box>
  );
};

export default ClusterFormProvidersBlock;
