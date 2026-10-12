import { FC } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';

export type FlowStep = { label: string; state: 'done' | 'current' | 'failed' | 'todo' };

/**
 * The steps of an upgrade: the step going on now is dark, finished steps are switched on (coloured, with a tick),
 * the next ones stay light grey until the one before them is done.
 */
const FlowStepper: FC<{ steps: FlowStep[]; running?: boolean }> = ({ steps, running }) => (
  <Stack direction="row" alignItems="flex-start">
    {steps.map((s, i) => {
      const color =
        s.state === 'done'
          ? 'success.main'
          : s.state === 'failed'
            ? 'error.main'
            : s.state === 'current'
              ? 'text.primary'
              : 'action.disabled';
      return (
        <Stack key={s.label} flex={1} alignItems="center" position="relative">
          {i > 0 ? (
            <Box
              sx={{
                position: 'absolute',
                top: 15,
                right: '50%',
                width: '100%',
                height: 3,
                borderRadius: 2,
                bgcolor: s.state === 'todo' ? 'action.disabledBackground' : 'success.main',
                opacity: s.state === 'todo' ? 1 : 0.85,
              }}
            />
          ) : null}
          <Box
            sx={{
              zIndex: 1,
              width: 32,
              height: 32,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              fontWeight: 800,
              fontSize: 14,
              color: s.state === 'todo' ? 'text.disabled' : 'background.paper',
              bgcolor: s.state === 'todo' ? 'action.disabledBackground' : color,
              boxShadow: s.state === 'current' ? 4 : 0,
              outline: s.state === 'current' ? '4px solid' : 'none',
              outlineColor: 'action.selected',
              animation: s.state === 'current' && running ? 'pgmPulse 1.6s ease-in-out infinite' : 'none',
              '@keyframes pgmPulse': {
                '0%, 100%': { outlineWidth: '3px' },
                '50%': { outlineWidth: '8px' },
              },
            }}>
            {s.state === 'done' ? (
              <CheckIcon fontSize="small" />
            ) : s.state === 'failed' ? (
              <CloseIcon fontSize="small" />
            ) : (
              i + 1
            )}
          </Box>
          <Typography
            variant="body2"
            mt={1}
            textAlign="center"
            sx={{
              fontWeight: s.state === 'current' ? 800 : 600,
              color: s.state === 'todo' ? 'text.disabled' : s.state === 'failed' ? 'error.main' : 'text.primary',
            }}>
            {s.label}
          </Typography>
        </Stack>
      );
    })}
  </Stack>
);

export default FlowStepper;

/**
 * The steps from what has happened so far. lastPlan / lastRun / lastRollback: the newest of each kind (or
 * undefined); the newest run of all decides which step is going on.
 */
export const flowSteps = (
  labels: [string, string, string, string],
  r: {
    plan?: { id: number; status: string };
    run?: { id: number; status: string };
    rollback?: { id: number; status: string; parent_id?: number | null };
  },
): FlowStep[] => {
  const { plan, run, rollback } = r;
  const runAfterPlan = run && plan && run.id > plan.id;
  const rbOfRun = rollback && run && rollback.parent_id === run.id;
  // 1 dry run, 2 review, 3 upgrade, 4 rollback
  const st: FlowStep['state'][] = ['current', 'todo', 'todo', 'todo'];
  if (plan) {
    if (plan.status === 'running') st[0] = 'current';
    else if (plan.status === 'failed' && !runAfterPlan) st[0] = 'failed';
    else st[0] = 'done';
    if (plan.status !== 'running' && !runAfterPlan) st[1] = 'current';
  }
  if (runAfterPlan && run) {
    st[0] = 'done';
    st[1] = 'done';
    st[2] = run.status === 'running' ? 'current' : run.status === 'failed' ? 'failed' : 'done';
    if (rbOfRun && rollback) {
      st[3] = rollback.status === 'running' ? 'current' : rollback.status === 'failed' ? 'failed' : 'done';
    } else if (run.status === 'failed') {
      st[3] = 'current';
    }
  }
  return labels.map((label, i) => ({ label, state: st[i] }));
};
