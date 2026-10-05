import { FC } from 'react';
import { useTranslation } from 'react-i18next';
import { handleRequestErrorCatch } from '@shared/lib/functions.ts';
import { Divider, ListItemIcon, MenuItem } from '@mui/material';
import { TableRowActionsProps } from '@shared/model/types.ts';
import { toast } from 'react-toastify';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import SyncIcon from '@mui/icons-material/Sync';
import { useDeleteServersByIdMutation } from '@shared/api/api/other.ts';
import { CLUSTER_OVERVIEW_TABLE_COLUMN_NAMES } from '@widgets/cluster-overview-table/model/constants.ts';
import { useLazyGetClustersByIdQuery } from '@shared/api/api/clusters.ts';
import {
  usePostClustersByIdSwitchoverMutation,
  usePostServersByIdReinitializeMutation,
  usePostServersByIdRestartMutation,
} from '@shared/api/api/patroni.ts';
import { useParams } from 'react-router-dom';
import { canManage, getSessionUser } from '@shared/lib/session.ts';

const isLeaderRole = (role?: string) => role === 'leader' || role === 'standby_leader';

/**
 * Server row actions on the cluster page. JumboSQL adds the Patroni actions: make this node the leader
 * (switchover), restart PostgreSQL, and reinitialize a replica from the leader.
 */
const ClustersOverviewTableRowActions: FC<TableRowActionsProps> = ({ closeMenu, row }) => {
  const { t } = useTranslation(['shared', 'toasts', 'clusters']);
  const { clusterId } = useParams();

  const [removeServerTrigger] = useDeleteServersByIdMutation();
  const [getClusterTrigger] = useLazyGetClustersByIdQuery();
  const [switchoverTrigger] = usePostClustersByIdSwitchoverMutation();
  const [restartTrigger] = usePostServersByIdRestartMutation();
  const [reinitializeTrigger] = usePostServersByIdReinitializeMutation();

  const serverId = Number(row.original[CLUSTER_OVERVIEW_TABLE_COLUMN_NAMES.ID]);
  const serverName = row.original[CLUSTER_OVERVIEW_TABLE_COLUMN_NAMES.NAME];
  const role = row.original[CLUSTER_OVERVIEW_TABLE_COLUMN_NAMES.ROLE] as string | undefined;
  const isLeader = isLeaderRole(role);

  const run = async (confirmText: string, action: () => Promise<{ message?: string }>) => {
    closeMenu();
    if (!window.confirm(confirmText)) return;
    try {
      const result = await action();
      toast.success(result?.message || t('patroniActionDone', { ns: 'clusters', serverName }));
      await getClusterTrigger({ id: clusterId });
    } catch (e) {
      handleRequestErrorCatch(e);
    }
  };

  const handleSwitchover = () =>
    run(t('patroniConfirmSwitchover', { ns: 'clusters', serverName }), () =>
      switchoverTrigger({ id: Number(clusterId), candidateServerId: serverId }).unwrap(),
    );

  const handleRestart = () =>
    run(t('patroniConfirmRestart', { ns: 'clusters', serverName }), () =>
      restartTrigger({ id: serverId, clusterId }).unwrap(),
    );

  const handleReinitialize = () =>
    run(t('patroniConfirmReinitialize', { ns: 'clusters', serverName }), () =>
      reinitializeTrigger({ id: serverId, clusterId }).unwrap(),
    );

  const handleRemove = async () => {
    try {
      await removeServerTrigger({ id: serverId }).unwrap();
      toast.success(t('serverSuccessfullyRemoved', { ns: 'toasts', serverName }));
      await getClusterTrigger({ id: clusterId });
    } catch (e) {
      handleRequestErrorCatch(e);
    } finally {
      closeMenu();
    }
  };

  if (!canManage(getSessionUser())) {
    return [
      <MenuItem key="readonly" disabled sx={{ m: 0 }}>
        {t('readOnlyRole', { ns: 'clusters' })}
      </MenuItem>,
    ];
  }

  return [
    <MenuItem key="switchover" onClick={handleSwitchover} disabled={isLeader} sx={{ m: 0 }}>
      <ListItemIcon>
        <SwapVertIcon />
      </ListItemIcon>
      {t('patroniMakeLeader', { ns: 'clusters' })}
    </MenuItem>,
    <MenuItem key="restart" onClick={handleRestart} sx={{ m: 0 }}>
      <ListItemIcon>
        <RestartAltIcon />
      </ListItemIcon>
      {t('patroniRestart', { ns: 'clusters' })}
    </MenuItem>,
    <MenuItem key="reinitialize" onClick={handleReinitialize} disabled={isLeader} sx={{ m: 0 }}>
      <ListItemIcon>
        <SyncIcon />
      </ListItemIcon>
      {t('patroniReinitialize', { ns: 'clusters' })}
    </MenuItem>,
    <Divider key="divider" />,
    <MenuItem key="remove" onClick={handleRemove} sx={{ m: 0 }}>
      <ListItemIcon>
        <DeleteOutlineIcon />
      </ListItemIcon>
      {t('removeFromList', { ns: 'shared' })}
    </MenuItem>,
  ];
};

export default ClustersOverviewTableRowActions;
