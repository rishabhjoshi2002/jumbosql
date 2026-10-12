import { FC } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import BuiltInUpgrades from './index.tsx';

/** pg_mantra Upgrades: one component of any cluster, dry run first, with a rollback. */
const UpgradesPage: FC = () => {
  const { t } = useTranslation('upgrade');
  return (
    <Stack gap={2} p={2}>
      <Box>
        <Typography variant="h6" fontWeight={800}>
          {t('title')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('help')}
        </Typography>
      </Box>
      <BuiltInUpgrades />
    </Stack>
  );
};

export default UpgradesPage;
