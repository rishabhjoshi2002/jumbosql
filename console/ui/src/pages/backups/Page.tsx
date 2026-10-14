import { FC } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import Backups from './ui/index.tsx';

/** pg_mantra Backups: pgBackRest of any cluster - recoverable window, backups, config, schedule, restore. */
const BackupsPage: FC = () => {
  const { t } = useTranslation('backup');
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
      <Backups />
    </Stack>
  );
};

export default BackupsPage;
