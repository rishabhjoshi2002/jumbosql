import { FC } from 'react';
import { Box, Stack, Tab, Tabs, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import BuiltInUpgrades from './index.tsx';
import CustomPlaybooks from './CustomPlaybooks.tsx';

/** pg_mantra Upgrades: built-in component upgrades, or your own playbooks. */
const UpgradesPage: FC = () => {
  const { t } = useTranslation('upgrade');
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'playbooks' ? 'playbooks' : 'builtin';
  return (
    <Stack gap={2} p={2}>
      <Box>
        <Typography variant="h6">{t('title')}</Typography>
        <Typography variant="body2" color="text.secondary">
          {tab === 'playbooks' ? t('pb.help') : t('help')}
        </Typography>
      </Box>
      <Tabs
        value={tab}
        onChange={(_, v: string) => setParams(v === 'playbooks' ? { tab: v } : {})}
        sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
        <Tab value="builtin" label={t('tabBuiltin')} />
        <Tab value="playbooks" label={t('tabPlaybooks')} />
      </Tabs>
      {tab === 'playbooks' ? <CustomPlaybooks /> : <BuiltInUpgrades />}
    </Stack>
  );
};

export default UpgradesPage;
