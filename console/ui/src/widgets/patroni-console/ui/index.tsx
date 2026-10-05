import { FC, ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import TerminalOutlined from '@mui/icons-material/TerminalOutlined';
import { useTranslation } from 'react-i18next';
import { PatroniCommandArg, PatroniMember, usePostClustersByIdPatroniMutation } from '@shared/api/api/patroni.ts';
import { canManage, getSessionUser } from '@shared/lib/session.ts';
import { BRAND } from '@shared/theme/theme.ts';
import { isLeader, memberIsBack, planRollingRestart } from '@widgets/patroni-console/lib/rolling.ts';

type LogLine = { kind: 'cmd' | 'ok' | 'err' | 'info' | 'data'; text: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorText = (e: unknown) => {
  const d = (e as { data?: { description?: string; title?: string } })?.data;
  return d?.description || d?.title || (e as Error)?.message || 'request failed';
};

const EDIT_CONFIG_EXAMPLE = `{
  "postgresql": {
    "parameters": {
      "max_connections": 200
    }
  }
}`;

const Group: FC<{ title: string; children: ReactNode }> = ({ title, children }) => (
  <Box>
    <Typography
      sx={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', color: 'text.secondary', mb: '8px' }}>
      {title.toUpperCase()}
    </Typography>
    <Stack direction="row" gap="8px" flexWrap="wrap" alignItems="center">
      {children}
    </Stack>
  </Box>
);

/**
 * JumboSQL: patronictl in the browser. Each button runs the matching Patroni REST call through the console
 * API and prints the equivalent patronictl command and its result, so operators see exactly what happened.
 */
const PatroniConsole: FC<{ clusterId: number; onChanged?: () => void }> = ({ clusterId, onChanged }) => {
  const { t } = useTranslation('clusters');
  const writable = canManage(getSessionUser());
  const [run, { isLoading }] = usePostClustersByIdPatroniMutation();

  const [members, setMembers] = useState<PatroniMember[]>([]);
  const [member, setMember] = useState('');
  const [candidate, setCandidate] = useState('');
  const [config, setConfig] = useState(EDIT_CONFIG_EXAMPLE);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const push = (...lines: LogLine[]) => setLog((l) => [...l, ...lines].slice(-400));

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  const exec = useCallback(
    async (arg: Omit<PatroniCommandArg, 'id'>, quiet = false) => {
      const res = await run({ id: clusterId, ...arg }).unwrap();
      if (!quiet) {
        push({ kind: 'cmd', text: `$ ${res.command ?? `patronictl ${arg.command}`}` });
        if (res.message) push({ kind: 'ok', text: res.message });
        if (res.data !== undefined && arg.command !== 'list') {
          push({ kind: 'data', text: JSON.stringify(res.data, null, 2) });
        }
      }
      if (arg.command === 'list') {
        const list = ((res.data as { members?: PatroniMember[] })?.members ?? []) as PatroniMember[];
        setMembers(list);
        if (!quiet) {
          push({
            kind: 'data',
            text: list
              .map(
                (m) =>
                  `${m.name.padEnd(14)} ${m.host.padEnd(16)} ${m.role.padEnd(12)} ${String(m.state).padEnd(10)} lag=${m.lag ?? 0}${m.pending_restart ? '  *pending restart' : ''}`,
              )
              .join('\n'),
          });
        }
        return list;
      }
      if (!['history', 'show-config'].includes(arg.command)) onChanged?.();
      return null;
    },
    [run, clusterId, onChanged],
  );

  const runCommand = async (arg: Omit<PatroniCommandArg, 'id'>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await exec(arg);
      if (!['list', 'history', 'show-config'].includes(arg.command)) await exec({ command: 'list' }, true);
    } catch (e) {
      push({ kind: 'err', text: `✗ ${arg.command}: ${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  // load the members once so the pickers have Patroni member names
  useEffect(() => {
    exec({ command: 'list' }, true).catch((e) => push({ kind: 'err', text: `✗ list: ${errorText(e)}` }));
  }, [exec]);

  const waitUntilBack = async (name: string) => {
    for (let i = 0; i < 60; i += 1) {
      await sleep(5000);
      const list = (await exec({ command: 'list' }, true)) ?? [];
      if (memberIsBack(list, name)) return;
    }
    throw new Error(`${name} did not come back within 5 minutes`);
  };

  const rollingRestart = async () => {
    if (!window.confirm(t('patroniConfirmRolling'))) return;
    setBusy(true);
    try {
      const list = (await exec({ command: 'list' }, true)) ?? [];
      const steps = planRollingRestart(list);
      push({ kind: 'info', text: `# rolling restart: ${steps.filter((s) => s.kind !== 'wait').length} steps` });
      for (const step of steps) {
        if (step.kind === 'restart') await exec({ command: 'restart', member: step.member });
        else if (step.kind === 'switchover') await exec({ command: 'switchover', candidate: step.to });
        else {
          push({ kind: 'info', text: `… waiting for ${step.member} to be streaming again` });
          await waitUntilBack(step.member);
          push({ kind: 'ok', text: `${step.member} is back` });
        }
      }
      push({ kind: 'ok', text: '✓ rolling restart finished' });
      await exec({ command: 'list' });
    } catch (e) {
      push({ kind: 'err', text: `✗ rolling restart stopped: ${errorText(e)}` });
    } finally {
      setBusy(false);
    }
  };

  const editConfig = () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(config);
    } catch {
      push({ kind: 'err', text: '✗ edit-config: the settings are not valid JSON' });
      return;
    }
    runCommand({ command: 'edit-config', config: parsed }, t('patroniConfirmEditConfig'));
  };

  const leader = members.find(isLeader);
  const replicas = members.filter((m) => !isLeader(m));
  const working = busy || isLoading;
  const memberSelect = (
    value: string,
    onChange: (v: string) => void,
    label: string,
    options: PatroniMember[],
    allowAll?: string,
  ) => (
    <TextField
      select
      size="small"
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      sx={{ minWidth: 200 }}
      slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }}>
      {allowAll ? <MenuItem value="">{allowAll}</MenuItem> : null}
      {options.map((m) => (
        <MenuItem key={m.name} value={m.name}>
          {m.name} · {m.role}
        </MenuItem>
      ))}
    </TextField>
  );

  return (
    <Paper sx={{ p: '20px', borderRadius: '14px' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" mb="16px" gap="12px" flexWrap="wrap">
        <Stack direction="row" alignItems="center" gap="10px">
          <TerminalOutlined />
          <Box>
            <Typography variant="h6" lineHeight={1.2}>
              {t('patroniConsole')}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {t('patroniConsoleHelp')}
            </Typography>
          </Box>
        </Stack>
        <Stack direction="row" gap="6px" alignItems="center">
          {leader ? <Chip size="small" color="primary" label={`${t('leader')}: ${leader.name}`} /> : null}
          <Chip size="small" label={`${members.length} ${t('members')}`} />
        </Stack>
      </Stack>

      {!writable ? (
        <Alert severity="info" sx={{ mb: '16px' }}>
          {t('patroniReadOnly')}
        </Alert>
      ) : null}

      <Stack direction={{ xs: 'column', lg: 'row' }} gap="20px">
        <Stack gap="18px" sx={{ flex: '1 1 52%' }}>
          <Group title={t('patroniInspect')}>
            <Button variant="outlined" size="small" disabled={working} onClick={() => runCommand({ command: 'list' })}>
              list
            </Button>
            <Button
              variant="outlined"
              size="small"
              disabled={working}
              onClick={() => runCommand({ command: 'history' })}>
              history
            </Button>
            <Button
              variant="outlined"
              size="small"
              disabled={working}
              onClick={() => runCommand({ command: 'show-config' })}>
              show-config
            </Button>
          </Group>

          {writable ? (
            <>
              <Divider />
              <Group title={t('patroniLeaderChange')}>
                {memberSelect(candidate, setCandidate, t('patroniCandidate'), replicas, t('patroniAnyReplica'))}
                <Tooltip title={t('patroniSwitchoverHelp')}>
                  <span>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={working || !leader}
                      onClick={() =>
                        runCommand(
                          { command: 'switchover', candidate: candidate || undefined },
                          t('patroniConfirmSwitchoverTo', { candidate: candidate || t('patroniAnyReplica') }),
                        )
                      }>
                      switchover
                    </Button>
                  </span>
                </Tooltip>
                <Tooltip title={t('patroniFailoverHelp')}>
                  <span>
                    <Button
                      variant="outlined"
                      color="error"
                      size="small"
                      disabled={working || !candidate}
                      onClick={() =>
                        runCommand({ command: 'failover', candidate }, t('patroniConfirmFailover', { candidate }))
                      }>
                      failover
                    </Button>
                  </span>
                </Tooltip>
              </Group>

              <Group title={t('patroniMembers')}>
                {memberSelect(member, setMember, t('patroniMember'), members, t('patroniAllMembers'))}
                <Button
                  variant="outlined"
                  size="small"
                  disabled={working}
                  onClick={() =>
                    runCommand(
                      { command: 'restart', member: member || undefined },
                      t('patroniConfirmRestartMember', { member: member || t('patroniAllMembers') }),
                    )
                  }>
                  restart
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={working}
                  onClick={() => runCommand({ command: 'reload', member: member || undefined })}>
                  reload
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={working || !member || member === leader?.name}
                  onClick={() => runCommand({ command: 'reinit', member }, t('patroniConfirmReinit', { member }))}>
                  reinit
                </Button>
              </Group>

              <Group title={t('patroniMaintenance')}>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={working}
                  onClick={() => runCommand({ command: 'pause' }, t('patroniConfirmPause'))}>
                  pause
                </Button>
                <Button
                  variant="outlined"
                  size="small"
                  disabled={working}
                  onClick={() => runCommand({ command: 'resume' })}>
                  resume
                </Button>
                <Tooltip title={t('patroniRollingHelp')}>
                  <span>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={working || members.length < 2}
                      onClick={rollingRestart}>
                      {t('patroniRollingRestart')}
                    </Button>
                  </span>
                </Tooltip>
              </Group>

              <Group title={t('patroniEditConfig')}>
                <TextField
                  multiline
                  minRows={5}
                  fullWidth
                  value={config}
                  onChange={(e) => setConfig(e.target.value)}
                  helperText={t('patroniEditConfigHelp')}
                  slotProps={{ input: { sx: { fontFamily: BRAND.fontMono, fontSize: '0.8rem' } } }}
                />
                <Button variant="outlined" size="small" disabled={working} onClick={editConfig}>
                  edit-config
                </Button>
              </Group>
            </>
          ) : null}
        </Stack>

        <Box sx={{ flex: '1 1 48%', minWidth: 0 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" mb="6px">
            <Typography sx={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.08em', color: 'text.secondary' }}>
              {t('patroniOutput').toUpperCase()}
            </Typography>
            <Button size="small" onClick={() => setLog([])} disabled={!log.length}>
              {t('clear')}
            </Button>
          </Stack>
          <Box
            ref={logRef}
            data-testid="patroni-output"
            sx={{
              height: { xs: 280, lg: 520 },
              overflow: 'auto',
              p: '14px',
              borderRadius: '12px',
              backgroundColor: BRAND.navy900,
              border: '1px solid rgba(255, 255, 255, 0.06)',
              color: '#C9D6EA',
              fontFamily: BRAND.fontMono,
              fontSize: '0.78rem',
              lineHeight: 1.55,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
            {log.length ? (
              log.map((l, i) => (
                <Box
                  key={i}
                  sx={{
                    color: { cmd: BRAND.sky, ok: '#7EE2A8', err: '#FF8A8A', info: '#F5C46B', data: '#C9D6EA' }[l.kind],
                    fontWeight: l.kind === 'cmd' ? 700 : 400,
                    mt: l.kind === 'cmd' && i > 0 ? '10px' : 0,
                  }}>
                  {l.text}
                </Box>
              ))
            ) : (
              <Box sx={{ color: 'rgba(201,214,234,0.5)' }}>{t('patroniOutputEmpty')}</Box>
            )}
            {working ? <Box sx={{ color: '#F5C46B', mt: '8px' }}>…</Box> : null}
          </Box>
        </Box>
      </Stack>
    </Paper>
  );
};

export default PatroniConsole;
