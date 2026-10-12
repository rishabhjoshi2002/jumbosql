import { FC } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import CustomPlaybooks from '@pages/upgrade/ui/CustomPlaybooks.tsx';

/** pg_mantra Ansible Playbooks: your own playbooks, by name, run on the machines you choose. */
const PlaybooksPage: FC = () => {
  const { t } = useTranslation('upgrade');
  return (
    <Stack gap={2} p={2}>
      <Box>
        <Typography variant="h6" fontWeight={800}>
          {t('pb.title')}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t('pb.help')}
        </Typography>
      </Box>
      <CustomPlaybooks />
    </Stack>
  );
};

export default PlaybooksPage;
