import { FC } from 'react';
import { Button, Stack } from '@mui/material';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { usePostClustersByIdRefreshMutation } from '@shared/api/api/clusters.ts';
import { usePostClustersByIdSwitchoverMutation } from '@shared/api/api/patroni.ts';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { useParams } from 'react-router-dom';
import RefreshGroup from '@features/refresh-group';
import { can } from '@shared/lib/session.ts';

const ClustersOverviewTableButtons: FC = () => {
  const { t } = useTranslation('clusters');
  const { clusterId } = useParams();

  const [refreshClusterTrigger] = usePostClustersByIdRefreshMutation();
  const [switchoverTrigger, switchoverState] = usePostClustersByIdSwitchoverMutation();

  const handleRefresh = () => {
    void refreshClusterTrigger({ id: Number(clusterId) });
  };

  // JumboSQL: cluster-level switchover; Patroni picks the healthiest replica as the new leader
  const handleSwitchover = async () => {
    if (!window.confirm(t('patroniConfirmAutoSwitchover'))) return;
    try {
      const result = await switchoverTrigger({ id: Number(clusterId) }).unwrap();
      toast.success(result?.message || t('patroniSwitchoverDone'));
      void refreshClusterTrigger({ id: Number(clusterId) });
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  return (
    <Stack direction="row" justifyContent="flex-end" alignItems="center" gap="8px">
      {can('patroni.manage', clusterId) ? (
        <Button
          variant="outlined"
          size="small"
          startIcon={<SwapVertIcon />}
          disabled={switchoverState.isLoading}
          onClick={handleSwitchover}>
          {t('patroniSwitchover')}
        </Button>
      ) : null}
      <RefreshGroup context="clusterOverview" onRefresh={handleRefresh} />
    </Stack>
  );
};

export default ClustersOverviewTableButtons;
