import { FC, useEffect, useMemo, useRef, useState } from 'react';
import { alpha, Box, Chip, CircularProgress, LinearProgress, Stack, Typography, useTheme } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import TuneIcon from '@mui/icons-material/Tune';
import ScheduleIcon from '@mui/icons-material/Schedule';
import { useTranslation } from 'react-i18next';
import { BAction } from '@shared/api/api/backup.ts';
import { HostProgress, LogProgress } from '@pages/upgrade/lib/ansibleLog.ts';
import { bytes } from '@pages/insights/lib/format.ts';

export type FlowNode = { name: string; address: string; role: 'primary' | 'replica' | 'repo' | 'down' | '' };
type Step = { host: string; phase: string; status: string; detail?: Record<string, unknown> };

const TO_REPO = new Set(['backup', 'prebackup', 'postbackup', 'bcheck', 'stanza']);
const FROM_REPO = new Set(['restore']);
const TO_NODES = new Set(['write', 'verify', 'undo', 'schedule']);

const anim = {
  '@keyframes bfPulse': {
    '0%': { boxShadow: '0 0 0 0 rgba(33,150,243,.45)' },
    '70%': { boxShadow: '0 0 0 12px rgba(33,150,243,0)' },
    '100%': { boxShadow: '0 0 0 0 rgba(33,150,243,0)' },
  },
  '@keyframes bfShake': {
    '0%,100%': { transform: 'translateX(0)' },
    '25%,75%': { transform: 'translateX(-4px)' },
    '50%': { transform: 'translateX(4px)' },
  },
  '@keyframes bfPop': { '0%': { transform: 'scale(.6)', opacity: 0 }, '100%': { transform: 'scale(1)', opacity: 1 } },
  '@keyframes bfSpin': { from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } },
};

const clock = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** a database: a cylinder with discs; `level` (0..1) fills it, `glow` while data moves */
const Cylinder: FC<{ color: string; level?: number; glow?: boolean; size?: number; uid: string }> = ({
  color,
  level,
  glow,
  size = 46,
  uid,
}) => {
  const w = size,
    h = size * 1.15,
    ry = size * 0.16;
  return (
    <svg width={w} height={h + 2} viewBox={`0 0 ${w} ${h + 2}`} style={{ overflow: 'visible', flex: 'none' }}>
      <defs>
        <clipPath id={`cyl-${uid}`}>
          <path d={`M1,${ry + 1} v${h - 2 * ry} a${w / 2 - 1},${ry} 0 0 0 ${w - 2},0 v-${h - 2 * ry} z`} />
        </clipPath>
      </defs>
      <path
        d={`M1,${ry + 1} v${h - 2 * ry} a${w / 2 - 1},${ry} 0 0 0 ${w - 2},0 v-${h - 2 * ry} z`}
        fill={alpha(color, 0.14)}
        stroke={color}
        strokeWidth={2}
      />
      {level !== undefined ? (
        <rect
          x={0}
          width={w}
          y={h + 2 - (h - ry) * level}
          height={h}
          fill={alpha(color, 0.45)}
          clipPath={`url(#cyl-${uid})`}
          style={{ transition: 'y 1.2s ease' }}
        />
      ) : null}
      {[0.38, 0.62].map((f) => (
        <path
          key={f}
          d={`M1,${ry + 1 + (h - 2 * ry) * f} a${w / 2 - 1},${ry} 0 0 0 ${w - 2},0`}
          fill="none"
          stroke={color}
          strokeOpacity={0.55}
          strokeWidth={1.5}
        />
      ))}
      <ellipse
        cx={w / 2}
        cy={ry + 1}
        rx={w / 2 - 1}
        ry={ry}
        fill={glow ? alpha(color, 0.7) : alpha(color, 0.3)}
        stroke={color}
        strokeWidth={2}>
        {glow ? <animate attributeName="fill-opacity" values="1;.35;1" dur="1.2s" repeatCount="indefinite" /> : null}
      </ellipse>
    </svg>
  );
};

/**
 * The live picture of a Backup & Restore job: the database nodes on the left, the pgBackRest repository on the
 * right, and the data itself moving between them (to the repository while it backs up, back to the nodes while it
 * restores), with the steps on top and the outcome at the end.
 */
const BackupFlow: FC<{
  action: BAction;
  p: LogProgress;
  running: boolean;
  failed: boolean;
  nodes: FlowNode[];
  repo: { host?: string; path?: string };
  steps: string[];
  stepOf: (task: string) => string | undefined;
  result?: (Step | { error: string })[] | null;
  startedAt?: string;
  finishedAt?: string | null;
}> = ({ action, p, running, failed, nodes, repo, steps, stepOf, result, startedAt, finishedAt }) => {
  const { t } = useTranslation(['backup', 'upgrade']);
  const theme = useTheme();
  const C = {
    blue: theme.palette.info.main,
    green: theme.palette.success.main,
    red: theme.palette.error.main,
    grey: theme.palette.text.disabled,
    orange: '#F28C28',
  };

  // elapsed time, ticking while it runs
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);
  const t0 = startedAt ? new Date(startedAt).getTime() : now;
  const t1 = running ? now : finishedAt ? new Date(finishedAt).getTime() : now;
  const elapsed = Math.max(0, (t1 - t0) / 1000);

  // where the job is now
  const lastStep = useRef('look');
  const mapped = running ? stepOf(p.task) : undefined;
  if (mapped) lastStep.current = mapped;
  const step = running ? (mapped ?? (p.task && TO_REPO.has(lastStep.current) ? '' : lastStep.current)) : '';
  const reached = useMemo(() => {
    const r = new Set<string>();
    Object.values(p.hosts).forEach((h) => h.ran.forEach((x) => stepOf(x) && r.add(stepOf(x) as string)));
    return r;
  }, [p, stepOf]);

  // the database nodes (the repository server is drawn as the repository)
  const db = nodes.filter((n) => n.role !== 'repo');
  const shown: FlowNode[] = db.length
    ? db
    : p.order.map((h) => ({ name: h, address: h, role: '' as const })).filter((n) => n.address !== repo.host);
  const host = (n: FlowNode): HostProgress | undefined => p.hosts[n.name] ?? p.hosts[n.address];
  const primary = shown.find((n) => n.role === 'primary');

  const dir = TO_REPO.has(step) ? 'toRepo' : FROM_REPO.has(step) ? 'fromRepo' : TO_NODES.has(step) ? 'toNodes' : '';
  const isActive = (n: FlowNode) => {
    if (!running || !dir) return false;
    const h = host(n);
    if (dir === 'toRepo') {
      // pgBackRest copies from the primary (from the node that runs it when there is no repository server)
      if (primary) return n === primary;
      return !!h && (h.state === 'working' || h.task === p.task);
    }
    if (dir === 'fromRepo') {
      const busy = shown.filter((x) => ['Restore', 'Restore standby'].includes(host(x)?.task ?? ''));
      return busy.length ? busy.includes(n) : true;
    }
    return true; // a config / schedule goes to every node
  };

  const steps_: Step[] = (result ?? []).filter((r): r is Step => !!r && typeof r === 'object' && 'phase' in r);
  const made = steps_.find((r) => r.phase === 'backup' || r.phase === 'post-backup')?.detail?.backup as
    { label?: string; type?: string; size?: number; repo_size?: number; start?: number; stop?: number } | undefined;
  const restoredSet = steps_.find((r) => r.phase === 'restore' && r.detail?.set)?.detail?.set as string | undefined;
  const errorText =
    (result ?? []).map((r) => (r as { error?: string }).error).find(Boolean) ||
    Object.values(p.hosts).find((h) => h.error)?.error;

  // sizes of the drawing
  const rowH = shown.length > 4 ? 66 : 84;
  const H = Math.max(Math.max(shown.length, 1) * rowH, 250);
  const top = (H - Math.max(shown.length, 1) * rowH) / 2;
  const MID = 180;
  const yOf = (i: number) => top + i * rowH + rowH / 2;
  const repoY = H / 2;
  const right = dir === 'toNodes' || action === 'config' || action === 'schedule';
  const packetColor = dir === 'fromRepo' ? C.orange : dir === 'toNodes' ? theme.palette.secondary.main : C.blue;

  const stateText = (n: FlowNode, h?: HostProgress) => {
    if (h?.state === 'failed' || h?.state === 'unreachable') return t(`rv.st_${h.state}`, { ns: 'upgrade' });
    if (isActive(n))
      return dir === 'toRepo' ? t('flow.sending') : dir === 'fromRepo' ? t('flow.receiving') : t('flow.updating');
    if (running && (step === 'stop' || step === 'start' || step === 'promote') && h?.state === 'working')
      return t(`rv.step_${step}`, { ns: 'upgrade' });
    if (!running && h && h.state !== 'waiting') return t(`rv.st_${h.state}`, { ns: 'upgrade' });
    return running ? t('flow.ready') : '—';
  };

  const headline = failed
    ? t('flow.failed')
    : !running
      ? action === 'restore'
        ? t('flow.restored')
        : action === 'backup'
          ? t('flow.backedUp')
          : t('flow.done')
      : dir === 'toRepo'
        ? t('flow.copying')
        : dir === 'fromRepo'
          ? t('flow.restoring')
          : step
            ? t(`rv.step_${step}`, { ns: 'upgrade' })
            : reached.size > 1
              ? t('flow.finishing')
              : t('flow.starting');

  return (
    <Stack gap={2} sx={anim}>
      {/* headline: what happens now, and for how long */}
      <Stack
        direction="row"
        alignItems="center"
        gap={1.5}
        sx={{
          p: 1.5,
          borderRadius: 2,
          bgcolor: alpha(failed ? C.red : running ? C.blue : C.green, 0.08),
          border: 1,
          borderColor: alpha(failed ? C.red : running ? C.blue : C.green, 0.35),
        }}>
        {running ? (
          <CircularProgress size={22} thickness={5} />
        ) : failed ? (
          <CancelIcon sx={{ color: C.red, fontSize: 26 }} />
        ) : (
          <CheckCircleIcon sx={{ color: C.green, fontSize: 26, animation: 'bfPop .4s ease-out' }} />
        )}
        <Typography fontWeight={800} flex={1}>
          {headline}
        </Typography>
        <Typography variant="body2" sx={{ fontFamily: '"JetBrains Mono", monospace', fontWeight: 700 }}>
          {clock(elapsed)}
        </Typography>
      </Stack>

      {running ? (
        <LinearProgress sx={{ mt: -1.5, borderRadius: 1 }} color={dir === 'fromRepo' ? 'warning' : 'info'} />
      ) : null}

      {/* the steps of this job */}
      <Stack direction="row" gap={0.75} flexWrap="wrap">
        {steps.map((s) => {
          const now_ = running && s === step;
          const ok = !now_ && (reached.has(s) || (!running && !failed));
          const skipped = !running && !reached.has(s) && !failed;
          return (
            <Chip
              key={s}
              size="small"
              icon={
                now_ ? (
                  <CircularProgress size={12} sx={{ ml: '6px !important' }} />
                ) : ok && !skipped ? (
                  <CheckCircleIcon />
                ) : failed && !reached.has(s) ? (
                  <RadioButtonUncheckedIcon />
                ) : (
                  <RadioButtonUncheckedIcon />
                )
              }
              label={t(`rv.step_${s}`, { ns: 'upgrade' })}
              color={now_ ? 'info' : ok && !skipped ? 'success' : 'default'}
              variant={now_ ? 'filled' : 'outlined'}
              sx={{ fontWeight: now_ ? 800 : 500, opacity: skipped ? 0.5 : 1 }}
            />
          );
        })}
      </Stack>

      {/* nodes  ->  data  ->  repository */}
      <Box sx={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto' }}>
        <Stack sx={{ flex: '1 1 210px', minWidth: 190, pt: `${top}px` }}>
          {shown.map((n, i) => {
            const h = host(n);
            const active = isActive(n);
            const bad = h?.state === 'failed' || h?.state === 'unreachable';
            const color = bad ? C.red : active ? C.blue : h && !running && h.state !== 'waiting' ? C.green : C.grey;
            return (
              <Stack
                key={n.address}
                direction="row"
                alignItems="center"
                gap={1.25}
                sx={{
                  height: rowH - 10,
                  my: '5px',
                  px: 1.25,
                  borderRadius: 2,
                  border: 2,
                  borderColor: alpha(color, active ? 1 : 0.55),
                  bgcolor: 'background.paper',
                  animation: active ? 'bfPulse 1.6s infinite' : bad ? 'bfShake .5s 1' : 'none',
                  transition: 'border-color .3s',
                }}>
                <Cylinder color={color} glow={active} size={rowH > 70 ? 36 : 30} uid={`n${i}`} />
                <Box minWidth={0} flex={1}>
                  <Stack direction="row" alignItems="center" gap={0.75}>
                    <Typography variant="body2" fontWeight={800} noWrap>
                      {n.address}
                    </Typography>
                    {n.role && n.role !== 'down' ? (
                      <Chip
                        size="small"
                        label={t(n.role)}
                        sx={{ height: 18, fontSize: 11, fontWeight: 700 }}
                        color={n.role === 'primary' ? 'primary' : 'default'}
                      />
                    ) : null}
                  </Stack>
                  <Typography variant="caption" sx={{ color, fontWeight: 700 }} noWrap display="block">
                    {stateText(n, h)}
                  </Typography>
                </Box>
              </Stack>
            );
          })}
        </Stack>

        {/* the data on its way */}
        <Box sx={{ flex: `0 0 ${MID}px`, position: 'relative' }}>
          <svg width={MID} height={H} viewBox={`0 0 ${MID} ${H}`} style={{ display: 'block' }}>
            <defs>
              <filter id="bf-glow" x="-50%" y="-50%" width="200%" height="200%">
                <feGaussianBlur stdDeviation="2.2" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            {shown.map((n, i) => {
              const d = `M2,${yOf(i)} C${MID / 2},${yOf(i)} ${MID / 2},${repoY} ${MID - 2},${repoY}`;
              const active = isActive(n);
              const h = host(n);
              const doneLink =
                !running && !failed && (action === 'backup' ? n === (primary ?? n) : !!h && h.state !== 'waiting');
              const bad = h?.state === 'failed';
              return (
                <g key={n.address}>
                  <path
                    d={d}
                    fill="none"
                    stroke={
                      bad
                        ? C.red
                        : active
                          ? alpha(packetColor, 0.35)
                          : doneLink
                            ? alpha(C.green, 0.6)
                            : alpha(C.grey, 0.35)
                    }
                    strokeWidth={active ? 6 : 2.5}
                    strokeLinecap="round"
                    strokeDasharray={active || doneLink || bad ? undefined : '4 6'}
                  />
                  {active ? (
                    <path
                      d={d}
                      fill="none"
                      stroke={packetColor}
                      strokeWidth={2}
                      strokeDasharray="2 10"
                      strokeLinecap="round">
                      <animate
                        attributeName="stroke-dashoffset"
                        from={dir === 'toRepo' ? 24 : 0}
                        to={dir === 'toRepo' ? 0 : 24}
                        dur="0.6s"
                        repeatCount="indefinite"
                      />
                    </path>
                  ) : null}
                  {active
                    ? [0, 1, 2, 3].map((k) => (
                        <g key={k} filter="url(#bf-glow)">
                          <rect x={-8} y={-5} width={16} height={10} rx={3} fill={packetColor}>
                            <animateMotion
                              dur="1.6s"
                              begin={`${-k * 0.4}s`}
                              repeatCount="indefinite"
                              path={d}
                              rotate="auto"
                              keyPoints={dir === 'toRepo' ? '0;1' : '1;0'}
                              keyTimes="0;1"
                              calcMode="linear"
                            />
                          </rect>
                        </g>
                      ))
                    : null}
                </g>
              );
            })}
          </svg>
          {running && dir ? (
            <Typography
              variant="caption"
              sx={{
                position: 'absolute',
                top: Math.max(repoY - 30, 0),
                left: 0,
                right: 0,
                textAlign: 'center',
                fontWeight: 800,
                color: packetColor,
                letterSpacing: 0.5,
              }}>
              {dir === 'toRepo' ? 'DATA + WAL →' : dir === 'fromRepo' ? '← DATA + WAL' : '← CONFIG'}
            </Typography>
          ) : null}
        </Box>

        {/* the repository (or pg_MANTRA itself for config / schedule) */}
        <Stack justifyContent="center" sx={{ flex: '0 0 200px', minWidth: 180, height: H, position: 'relative' }}>
          <Stack
            alignItems="center"
            gap={0.75}
            sx={{
              p: 1.5,
              borderRadius: 3,
              border: 2,
              borderColor: alpha(dir ? packetColor : !running && !failed ? C.green : C.grey, 0.8),
              bgcolor: 'background.paper',
              animation: running && dir && !right ? 'bfPulse 1.6s infinite' : 'none',
            }}>
            {right ? (
              <Box
                sx={{
                  width: 56,
                  height: 56,
                  borderRadius: '50%',
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: alpha(packetColor, 0.12),
                }}>
                {action === 'schedule' ? (
                  <ScheduleIcon sx={{ fontSize: 34, color: packetColor }} />
                ) : (
                  <TuneIcon
                    sx={{ fontSize: 34, color: packetColor, animation: running ? 'bfSpin 3s linear infinite' : 'none' }}
                  />
                )}
              </Box>
            ) : (
              <Cylinder
                color={dir === 'fromRepo' ? C.orange : !running && !failed ? C.green : C.blue}
                level={
                  dir === 'toRepo'
                    ? 0.35 + ((elapsed % 8) / 8) * 0.55
                    : running && dir === 'fromRepo'
                      ? 0.85 - ((elapsed % 8) / 8) * 0.5
                      : 0.75
                }
                glow={!!dir}
                size={64}
                uid="repo"
              />
            )}
            <Typography variant="body2" fontWeight={800} textAlign="center">
              {right ? 'pg_MANTRA' : t('flow.repository')}
            </Typography>
            <Typography variant="caption" color="text.secondary" textAlign="center" sx={{ wordBreak: 'break-all' }}>
              {right
                ? t(action === 'schedule' ? 'flow.schedule' : 'flow.config')
                : [repo.host, repo.path].filter(Boolean).join(' · ') || 'pgBackRest'}
            </Typography>
            {made?.label && !running ? (
              <Chip
                size="small"
                color="success"
                label={made.label}
                sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 11, animation: 'bfPop .5s ease-out' }}
              />
            ) : null}
          </Stack>
        </Stack>
      </Box>

      {/* the outcome */}
      {!running && !failed && made ? (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0,1fr))',
            gap: 1,
            animation: 'bfPop .5s ease-out',
          }}>
          {[
            [t('flow.type'), made.type ? t(made.type) : '—'],
            [t('flow.size'), made.size ? bytes(made.size) : '—'],
            [t('flow.stored'), made.repo_size ? bytes(made.repo_size) : '—'],
            [t('flow.took'), made.start && made.stop ? clock(made.stop - made.start) : clock(elapsed)],
          ].map(([k, v]) => (
            <Box key={k} sx={{ p: 1, borderRadius: 1.5, bgcolor: alpha(C.green, 0.08), textAlign: 'center' }}>
              <Typography variant="caption" color="text.secondary" display="block">
                {k}
              </Typography>
              <Typography fontWeight={800}>{v}</Typography>
            </Box>
          ))}
        </Box>
      ) : null}
      {!running && !failed && restoredSet ? (
        <Typography variant="body2" fontWeight={700} sx={{ color: C.green }}>
          {t('restoredSet', { set: restoredSet })}
        </Typography>
      ) : null}
      {failed && errorText ? (
        <Typography variant="body2" color="error" sx={{ wordBreak: 'break-word' }}>
          {errorText}
        </Typography>
      ) : null}
    </Stack>
  );
};

export default BackupFlow;
