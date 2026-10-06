import { FC } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Button, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import StorageIcon from '@mui/icons-material/Storage';
import { ConnectionInfoProps } from '@entities/cluster/connection-info/model/types.ts';
import PowerOutlinedIcon from '@mui/icons-material/PowerOutlined';
import { useGetConnectionInfoConfig } from '@entities/cluster/connection-info/lib/hooks.tsx';
import InfoCardBody from '@shared/ui/info-card-body';
import { canAny } from '@shared/lib/session.ts';
import RouterPaths from '@app/router/routerPathsConfig';

const ConnectionInfo: FC<ConnectionInfoProps> = ({ connectionInfo }) => {
  const { t } = useTranslation(['clusters', 'shared']);
  const navigate = useNavigate();
  const { clusterId } = useParams();

  const config = useGetConnectionInfoConfig({ connectionInfo });

  return (
    <Accordion defaultExpanded>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <PowerOutlinedIcon />
        <Typography>{t('connectionInfo')}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <InfoCardBody config={config} />
        {connectionInfo?.address && canAny(['sql.read', 'sql.write', 'sql.admin'], clusterId) && (
          <Button
            variant="outlined"
            size="small"
            startIcon={<StorageIcon />}
            onClick={() => {
              navigate(`${RouterPaths.sqlEditor.absolutePath}${clusterId ? `?cluster=${clusterId}` : ''}`);
            }}
            sx={{ mt: 2 }}>
            {t('openInSqlEditor', { ns: 'shared' })}
          </Button>
        )}
      </AccordionDetails>
    </Accordion>
  );
};

export default ConnectionInfo;
