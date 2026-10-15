import { FC } from 'react';
import { Box, Chip, CircularProgress, LinearProgress, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import ViewInArIcon from '@mui/icons-material/ViewInAr';
import DnsIcon from '@mui/icons-material/DnsOutlined';
import { useTranslation } from 'react-i18next';
import { HostProgress, HostState } from '../lib/ansibleLog.ts';

const STATE_COLOR: Record<HostState, string> = {
  waiting: 'action.disabled',
  working: 'info.main',
  ok: 'success.main',
  changed: 'success.main',
  skipped: 'text.disabled',
  failed: 'error.main',
  unreachable: 'error.main',
};

const flow = {
  '@keyframes pgmFlow': { from: { backgroundPosition: '0 0' }, to: { backgroundPosition: '0 24px' } },
  '@keyframes pgmShake': {
    '0%, 100%': { transform: 'translateX(0)' },
    '20%, 60%': { transform: 'translateX(-4px)' },
    '40%, 80%': { transform: 'translateX(4px)' },
  },
  '@keyframes pgmGlow': {
    '0%, 100%': { boxShadow: '0 0 0 0 rgba(33,150,243,0.35)' },
    '50%': { boxShadow: '0 0 0 8px rgba(33,150,243,0)' },
  },
};

/** a line that "flows" downwards while active */
const Wire: FC<{ active: boolean; color: string; h?: number }> = ({ active, color, h = 26 }) => (
  <Box
    sx={{
      ...flow,
      width: 3,
      height: h,
      mx: 'auto',
      borderRadius: 2,
      bgcolor: active ? undefined : color,
      opacity: active ? 1 : 0.5,
      backgroundImage: active
        ? 'repeating-linear-gradient(180deg, rgba(33,150,243,1) 0 8px, rgba(33,150,243,0.15) 8px 12px)'
        : undefined,
      backgroundSize: '3px 24px',
      animation: active ? 'pgmFlow 0.7s linear infinite' : 'none',
    }}
  />
);

/**
 * The live picture of a run: the runner container at the top, a line to every machine, and on each machine what
 * it is doing now - its steps (built-in upgrades) or its current task (playbooks).
 */
const RunProgress: FC<{
  hosts: HostProgress[];
  running: boolean;
  task: string;
  steps?: string[]; // built-in upgrade steps (keys), in order
  stepOf?: (task: string) => string | undefined;
  roles?: Record<string, string>;
}> = ({ hosts, running, task, steps, stepOf, roles }) => {
  const { t } = useTranslation('upgrade');
  return (
    <Stack alignItems="stretch" sx={flow}>
      <Stack direction="row" justifyContent="center">
        <Stack
          direction="row"
          gap={1.25}
          alignItems="center"
          sx={{
            px: 2,
            py: 1.25,
            borderRadius: 2,
            border: 2,
            borderColor: running ? 'info.main' : 'divider',
            bgcolor: 'background.paper',
            animation: running ? 'pgmGlow 1.8s ease-in-out infinite' : 'none',
          }}>
          <ViewInArIcon color={running ? 'info' : 'disabled'} />
          <Box>
            <Typography variant="body2" fontWeight={800}>
              {t('rv.runner')}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" noWrap sx={{ maxWidth: 360 }}>
              {running ? (task ? t('rv.on', { task }) : t('rv.starting')) : t('rv.stopped')}
            </Typography>
          </Box>
          {running ? <CircularProgress size={18} /> : null}
        </Stack>
      </Stack>
      <Wire active={running} color="divider" />
      <Box
        sx={{
          borderTop: 3,
          borderColor: running ? 'info.light' : 'divider',
          mx: hosts.length > 1 ? `${50 / hosts.length}%` : '50%',
          opacity: 0.6,
        }}
      />
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: `repeat(${Math.min(Math.max(hosts.length, 1), 3)}, minmax(0,1fr))`,
        }}>
        {hosts.map((h) => {
          const working = running && h.state === 'working';
          const failed = h.state === 'failed' || h.state === 'unreachable';
          const color = STATE_COLOR[running || h.state !== 'working' ? h.state : 'ok'];
          const reached = steps && stepOf ? new Set(h.tasks.map(stepOf).filter(Boolean) as string[]) : null;
          const cur = stepOf?.(h.task);
          return (
            <Box key={h.host}>
              <Wire active={working} color={failed ? 'error.main' : 'divider'} h={18} />
              <Box
                sx={{
                  border: 2,
                  borderColor: color,
                  borderRadius: 2,
                  p: 1.25,
                  bgcolor: 'background.paper',
                  animation: failed ? 'pgmShake 0.5s ease-in-out 1' : working ? 'pgmGlow 1.8s infinite' : 'none',
                  transition: 'border-color .3s',
                }}>
                <Stack direction="row" alignItems="center" gap={0.75}>
                  <DnsIcon fontSize="small" sx={{ color }} />
                  <Typography variant="body2" fontWeight={800} noWrap flex={1}>
                    {h.host}
                  </Typography>
                  {roles?.[h.host] ? <Chip size="small" label={roles[h.host]} sx={{ height: 20 }} /> : null}
                </Stack>
                <Typography variant="caption" sx={{ color, fontWeight: 700 }} display="block" mt={0.5}>
                  {t(`rv.st_${running || h.state !== 'working' ? h.state : 'ok'}`)}
                </Typography>
                {steps && reached ? (
                  <Stack gap={0.25} mt={0.75}>
                    {steps.map((s) => {
                      const done = reached.has(s) && (s !== cur || !working);
                      const now = working && s === cur;
                      const bad = failed && s === cur;
                      return (
                        <Stack key={s} direction="row" gap={0.75} alignItems="center">
                          {bad ? (
                            <CancelIcon sx={{ fontSize: 16, color: 'error.main' }} />
                          ) : now ? (
                            <CircularProgress size={13} sx={{ mx: '1.5px' }} />
                          ) : done ? (
                            <CheckCircleIcon sx={{ fontSize: 16, color: 'success.main' }} />
                          ) : h.state === 'skipped' || (h.state !== 'waiting' && h.state !== 'working') ? (
                            <RemoveCircleOutlineIcon sx={{ fontSize: 16, color: 'text.disabled' }} />
                          ) : (
                            <RadioButtonUncheckedIcon sx={{ fontSize: 16, color: 'action.disabled' }} />
                          )}
                          <Typography
                            variant="caption"
                            sx={{ fontWeight: now ? 800 : 500, color: now ? 'text.primary' : 'text.secondary' }}>
                            {t(`rv.step_${s}`)}
                          </Typography>
                        </Stack>
                      );
                    })}
                  </Stack>
                ) : (
                  <>
                    <Typography variant="caption" color="text.secondary" display="block" noWrap mt={0.5}>
                      {h.task || '—'}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {t('rv.counts', { n: h.tasks.length, c: h.changed })}
                    </Typography>
                  </>
                )}
                {working ? <LinearProgress sx={{ mt: 1, borderRadius: 1 }} /> : null}
                {h.error ? (
                  <Typography
                    variant="caption"
                    color="error"
                    display="block"
                    mt={0.75}
                    sx={{ wordBreak: 'break-word' }}>
                    {h.error}
                  </Typography>
                ) : null}
              </Box>
            </Box>
          );
        })}
      </Box>
      {!hosts.length ? (
        <Typography variant="body2" color="text.secondary" textAlign="center" mt={2}>
          {running ? t('rv.connecting') : t('rv.noHosts')}
        </Typography>
      ) : null}
    </Stack>
  );
};

export default RunProgress;
