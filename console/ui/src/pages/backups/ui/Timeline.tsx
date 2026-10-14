import { FC, useMemo } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useTranslation } from 'react-i18next';
import { BBackup, BStatus } from '@shared/api/api/backup.ts';
import { bytes } from '@pages/insights/lib/format.ts';

const TYPE_COLOR = { full: '#F28C28', diff: '#7c4dff', incr: '#26a69a' } as const;

export const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '—';

/** The recovery timeline: the window that can be restored (blue band), the backups (dots) and now. */
const Timeline: FC<{ status: BStatus; onPick?: (b: BBackup) => void }> = ({ status, onPick }) => {
  const { t } = useTranslation('backup');
  const now = new Date(status.checked_at).getTime();
  const { min, span } = useMemo(() => {
    const starts = status.backups.map((b) => new Date(b.stop).getTime());
    const lo = Math.min(...starts, status.window.from ? new Date(status.window.from).getTime() : now);
    const pad = Math.max((now - lo) * 0.04, 60_000);
    return { min: lo - pad, span: now + pad - (lo - pad) };
  }, [status, now]);
  const x = (ms: number) => `${Math.max(0, Math.min(100, ((ms - min) / span) * 100))}%`;
  const from = status.window.from ? new Date(status.window.from).getTime() : null;
  const to = status.window.to ? new Date(status.window.to).getTime() : null;
  // no real WAL waiting to be archived: the gap up to now is quiet, not data at risk
  const pend = status.window.pending_wal_bytes;
  const quiet = pend !== undefined && pend !== null && pend < 64 * 1024;

  return (
    <Box>
      <Box sx={{ position: 'relative', height: 64, mx: 1 }}>
        <Box
          sx={{ position: 'absolute', top: 30, left: 0, right: 0, height: 4, bgcolor: 'divider', borderRadius: 2 }}
        />
        {from && to ? (
          <Tooltip title={`${when(status.window.from)} → ${when(status.window.to)}`}>
            <Box
              sx={{
                position: 'absolute',
                top: 24,
                height: 16,
                left: x(from),
                width: `calc(${x(to)} - ${x(from)})`,
                minWidth: 4,
                borderRadius: 1,
                bgcolor: 'rgba(33,150,243,0.35)',
                border: '1px solid',
                borderColor: 'info.main',
              }}
            />
          </Tooltip>
        ) : null}
        {to ? (
          <Box
            sx={{
              position: 'absolute',
              top: 24,
              height: 16,
              left: x(to),
              width: `calc(${x(now)} - ${x(to)})`,
              backgroundImage: quiet
                ? 'repeating-linear-gradient(45deg, rgba(120,130,150,.35) 0 4px, transparent 4px 8px)'
                : 'repeating-linear-gradient(45deg, rgba(244,67,54,.45) 0 4px, transparent 4px 8px)',
            }}
          />
        ) : null}
        {status.backups.map((b) => (
          <Tooltip
            key={b.label}
            title={`${b.label} · ${t(b.type)} · ${bytes(b.size)}${b.usable ? '' : ` · ${t('notUsable')}`}`}>
            <Box
              onClick={() => b.usable && onPick?.(b)}
              sx={{
                position: 'absolute',
                top: b.type === 'full' ? 22 : 25,
                left: x(new Date(b.stop).getTime()),
                transform: 'translateX(-50%)',
                width: b.type === 'full' ? 20 : 14,
                height: b.type === 'full' ? 20 : 14,
                borderRadius: '50%',
                bgcolor: b.usable ? TYPE_COLOR[b.type] : 'action.disabled',
                border: '2px solid',
                borderColor: 'background.paper',
                cursor: b.usable && onPick ? 'pointer' : 'default',
                boxShadow: 1,
              }}
            />
          </Tooltip>
        ))}
        <Box sx={{ position: 'absolute', top: 12, bottom: 12, left: x(now), width: 2, bgcolor: 'text.primary' }} />
        <Typography
          variant="caption"
          sx={{ position: 'absolute', top: -2, left: x(now), transform: 'translateX(-50%)' }}>
          {t('now')}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ position: 'absolute', bottom: -4, left: 0 }}>
          {when(new Date(min).toISOString())}
        </Typography>
      </Box>
      <Stack direction="row" gap={2} mt={1.5} flexWrap="wrap" alignItems="center">
        {(['full', 'diff', 'incr'] as const).map((k) => (
          <Stack key={k} direction="row" gap={0.75} alignItems="center">
            <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: TYPE_COLOR[k] }} />
            <Typography variant="caption">{t(k)}</Typography>
          </Stack>
        ))}
        <Typography variant="caption" color="text.secondary" ml="auto">
          {t('timelineHelp')}
        </Typography>
      </Stack>
    </Box>
  );
};

export default Timeline;
