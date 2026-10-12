import { FC, ReactNode, useEffect, useMemo, useRef } from 'react';
import { Box, Button, Chip, Stack, Typography } from '@mui/material';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import { useTranslation } from 'react-i18next';
import Card from '@pages/discover/ui/Card.tsx';
import { parseAnsibleLog } from '../lib/ansibleLog.ts';
import RunProgress from './RunProgress.tsx';

const STATUS = { running: 'info', success: 'success', failed: 'error' } as const;

/**
 * A run on screen: the live picture on the left, the Ansible log on the right; the actions for what comes next
 * (proceed, roll back now, try again) under it, and the detailed result below.
 */
const RunView: FC<{
  title: string;
  status: 'running' | 'success' | 'failed';
  log: string;
  knownHosts?: string[];
  steps?: string[];
  stepOf?: (task: string) => string | undefined;
  roles?: Record<string, string>;
  actions?: ReactNode;
  onBack: () => void;
  children?: ReactNode;
}> = ({ title, status, log, knownHosts, steps, stepOf, roles, actions, onBack, children }) => {
  const { t } = useTranslation('upgrade');
  const running = status === 'running';
  const p = useMemo(() => parseAnsibleLog(log, knownHosts), [log, knownHosts]);
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [log]);

  return (
    <Stack gap={2}>
      <Stack direction="row" alignItems="center" gap={1.5} flexWrap="wrap">
        <Button size="small" startIcon={<ArrowBackIcon />} onClick={onBack} disabled={running}>
          {t('rv.back')}
        </Button>
        <Typography variant="h6" fontWeight={800} flex={1}>
          {title}
        </Typography>
        <Chip color={STATUS[status]} label={t(`st_${status}`)} sx={{ fontWeight: 800 }} />
      </Stack>
      <Box
        sx={{
          display: 'grid',
          gap: 2,
          alignItems: 'stretch',
          gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,1fr) minmax(0,1fr)' },
        }}>
        <Card title={t('rv.progress')}>
          <RunProgress
            hosts={p.order.map((h) => p.hosts[h])}
            running={running}
            task={p.task}
            steps={steps}
            stepOf={stepOf}
            roles={roles}
          />
        </Card>
        <Card title={t('rv.logs')}>
          <Box
            component="pre"
            ref={ref}
            sx={{
              fontFamily: '"JetBrains Mono", monospace',
              fontSize: 11.5,
              m: 0,
              p: 1.25,
              bgcolor: '#0d1421',
              color: '#d6e2f0',
              borderRadius: 1.5,
              height: 460,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
            {log.slice(-40000) || t('noLog')}
          </Box>
        </Card>
      </Box>
      {actions ? (
        <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
          {actions}
        </Stack>
      ) : null}
      {children}
    </Stack>
  );
};

export default RunView;
