import { FC, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  LinearProgress,
  ListItemText,
  MenuItem,
  Stack,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { selectActualTheme } from '@app/redux/slices/themeSlice/themeSelectors.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import { useGetLogFilesQuery, useLazyGetLogChunkQuery } from '@shared/api/api/access.ts';
import { can } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import { atLeast, formatBytes, Level, LogEntry, parseLog } from '../lib/logLines.ts';

const MAX_BUFFER = 8 * 1024 * 1024; // characters kept in the browser
const MAX_SHOWN = 4000; // entries rendered
const LIVE_EVERY_MS = 3000;

const LEVEL_COLORS: Record<string, { light: string; dark: string }> = {
  PANIC: { light: '#b71c1c', dark: '#ff8a80' },
  FATAL: { light: '#c62828', dark: '#ff8a80' },
  ERROR: { light: '#d32f2f', dark: '#ef9a9a' },
  WARNING: { light: '#a15c00', dark: '#ffcc80' },
  NOTICE: { light: '#1565c0', dark: '#90caf9' },
  DEBUG: { light: '#757575', dark: '#9e9e9e' },
};

/** a readable message for any failed request (API error, proxy error page, broken response, network error) */
const errorText = (e: unknown) => {
  const x = (e ?? {}) as {
    status?: number | string;
    originalStatus?: number;
    data?: unknown;
    error?: string;
    message?: string;
  };
  const d = x.data as { title?: string; description?: string } | string | undefined;
  if (d && typeof d === 'object' && (d.description || d.title)) return String(d.description || d.title);
  const status = x.originalStatus ?? x.status;
  const body =
    typeof d === 'string'
      ? d
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300)
      : '';
  const detail = x.error || body || x.message || '';
  return [status !== undefined ? `HTTP ${status}` : '', detail].filter(Boolean).join(' - ') || 'request failed';
};

const highlight = (text: string, q: string): ReactNode => {
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let at = lower.indexOf(needle);
  while (at >= 0) {
    parts.push(text.slice(i, at));
    parts.push(
      <mark key={at} style={{ background: '#ffeb3b', color: '#000', padding: 0 }}>
        {text.slice(at, at + q.length)}
      </mark>,
    );
    i = at + q.length;
    at = lower.indexOf(needle, i);
  }
  parts.push(text.slice(i));
  return parts;
};

/** pg_genie: PostgreSQL server logs of every node, read over SQL (pg_ls_logdir / pg_read_binary_file). */
const PostgresLogs: FC = () => {
  const { t } = useTranslation(['shared', 'settings']);
  useSessionUser(); // re-render when permissions change
  const dark = useAppSelector(selectActualTheme) === 'dark';
  const projectId = useAppSelector(selectCurrentProject);
  const [params, setParams] = useSearchParams();
  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId, pollingInterval: 30000 },
  );
  const allowed = useMemo(
    () => (clusters.data?.data ?? []).filter((c) => c.id && can('logs.view', c.id)),
    [clusters.data],
  );

  const clusterId = Number(params.get('cluster')) || allowed[0]?.id || 0;
  const cluster = allowed.find((c) => c.id === clusterId);
  const servers = (cluster?.servers ?? []).filter((s) => s.id);
  const serverId =
    Number(params.get('server')) ||
    servers.find((s) => s.role === 'leader' || s.role === 'primary')?.id ||
    servers[0]?.id ||
    0;
  const setParam = (k: string, v: string | number, reset: string[] = []) => {
    const next = new URLSearchParams(params);
    next.set(k, String(v));
    reset.forEach((r) => next.delete(r));
    setParams(next, { replace: true });
  };

  const files = useGetLogFilesQuery({ id: clusterId, server_id: serverId }, { skip: !clusterId || !serverId });
  const file = params.get('file') || files.data?.current || files.data?.files?.[0]?.name || '';
  const isCurrent = !!file && file === files.data?.current;

  const [tailKb, setTailKb] = useState(256);
  const [live, setLive] = useState(true);
  const [minLevel, setMinLevel] = useState<Level | 'ALL'>('ALL');
  const [q, setQ] = useState('');
  const [onlyMatches, setOnlyMatches] = useState(true);
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [meta, setMeta] = useState({ next: 0, size: 0, truncated: false, chars: 0 });
  const [loadError, setLoadError] = useState('');
  const [fetchChunk, chunkState] = useLazyGetLogChunkQuery();
  const raw = useRef('');
  const boxRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const key = `${clusterId}/${serverId}/${file}`;
  const keyRef = useRef(key);
  keyRef.current = key;

  const load = useCallback(async () => {
    if (!clusterId || !serverId || !file) return;
    const k = key;
    setLoadError('');
    try {
      const c = await fetchChunk({ id: clusterId, server_id: serverId, file, tail_kb: tailKb }).unwrap();
      if (keyRef.current !== k) return;
      raw.current = c.text;
      setEntries(parseLog(c.text));
      setMeta({ next: c.next, size: c.size, truncated: c.offset > 0, chars: c.text.length });
      stickToBottom.current = true;
    } catch (e) {
      setEntries([]);
      raw.current = '';
      setLoadError(errorText(e));
    }
  }, [clusterId, serverId, file, tailKb, fetchChunk, key]);

  useEffect(() => {
    void load();
  }, [load]);

  // live tail: ask for what was written since the last read
  useEffect(() => {
    if (!live || !isCurrent || loadError) return;
    const timer = window.setInterval(async () => {
      const k = keyRef.current;
      try {
        const c = await fetchChunk({ id: clusterId, server_id: serverId, file, since: meta.next }).unwrap();
        if (keyRef.current !== k) return;
        if (c.offset < meta.next) {
          // file was rotated / truncated: start over
          void load();
          return;
        }
        if (!c.text) {
          setMeta((m) => ({ ...m, size: c.size }));
          return;
        }
        let text = raw.current + c.text;
        let dropped = false;
        if (text.length > MAX_BUFFER) {
          text = text.slice(text.length - MAX_BUFFER);
          text = text.slice(text.indexOf('\n') + 1);
          dropped = true;
        }
        raw.current = text;
        setEntries(parseLog(text));
        setMeta((m) => ({ next: c.next, size: c.size, truncated: m.truncated || dropped, chars: text.length }));
      } catch {
        /* a missed poll is retried on the next tick */
      }
    }, LIVE_EVERY_MS);
    return () => window.clearInterval(timer);
  }, [live, isCurrent, loadError, clusterId, serverId, file, meta.next, fetchChunk, load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    entries.forEach((e) => (c[e.level] = (c[e.level] ?? 0) + 1));
    return c;
  }, [entries]);

  const shown = useMemo(() => {
    const needle = q.toLowerCase();
    const list = entries.filter(
      (e) => atLeast(e, minLevel) && (!needle || !onlyMatches || e.text.toLowerCase().includes(needle)),
    );
    return list.slice(-MAX_SHOWN);
  }, [entries, minLevel, q, onlyMatches]);
  const hiddenOlder = useMemo(() => {
    const needle = q.toLowerCase();
    return (
      entries.filter((e) => atLeast(e, minLevel) && (!needle || !onlyMatches || e.text.toLowerCase().includes(needle)))
        .length - shown.length
    );
  }, [entries, minLevel, q, onlyMatches, shown.length]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const download = () => {
    const blob = new Blob([raw.current], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${cluster?.name ?? 'cluster'}-${servers.find((s) => s.id === serverId)?.name ?? 'node'}-${file}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  if (clusters.isSuccess && !allowed.length) {
    return (
      <Box p={2}>
        <Alert severity="info">{t('noLogClusters')}</Alert>
      </Box>
    );
  }

  return (
    <Stack gap={1.5} p={2} sx={{ height: 'calc(100vh - 110px)', minHeight: 480 }}>
      <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
        <TextField
          select
          size="small"
          label={t('cluster', { ns: 'settings' })}
          value={cluster ? clusterId : ''}
          onChange={(e) => setParam('cluster', e.target.value, ['server', 'file'])}
          sx={{ minWidth: 180 }}>
          {allowed.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('node')}
          value={servers.some((s) => s.id === serverId) ? serverId : ''}
          onChange={(e) => setParam('server', e.target.value, ['file'])}
          sx={{ minWidth: 220 }}>
          {servers.map((s) => (
            <MenuItem key={s.id} value={s.id}>
              <ListItemText primary={`${s.name} (${s.ip})`} secondary={s.role} />
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('logFile')}
          value={files.data?.files?.some((f) => f.name === file) ? file : ''}
          onChange={(e) => setParam('file', e.target.value)}
          sx={{ minWidth: 260 }}>
          {(files.data?.files ?? []).map((f) => (
            <MenuItem key={f.name} value={f.name}>
              <ListItemText
                primary={
                  <>
                    {f.name}
                    {f.name === files.data?.current ? (
                      <Chip size="small" color="success" label={t('current')} sx={{ ml: 1, height: 18 }} />
                    ) : null}
                  </>
                }
                secondary={`${formatBytes(f.size)} · ${new Date(f.modified).toLocaleString()}`}
              />
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('loadLast')}
          value={tailKb}
          onChange={(e) => setTailKb(Number(e.target.value))}
          sx={{ width: 120 }}>
          {[64, 256, 1024, 4096, 8192].map((kb) => (
            <MenuItem key={kb} value={kb}>
              {kb >= 1024 ? `${kb / 1024} MB` : `${kb} KB`}
            </MenuItem>
          ))}
        </TextField>
        <Tooltip title={isCurrent ? t('liveTailHint') : t('liveTailOnlyCurrent')}>
          <FormControlLabel
            control={
              <Switch checked={live && isCurrent} disabled={!isCurrent} onChange={(e) => setLive(e.target.checked)} />
            }
            label={t('liveTail')}
          />
        </Tooltip>
        <Box flex={1} />
        <Button size="small" startIcon={<RefreshIcon />} onClick={() => void load()}>
          {t('refresh')}
        </Button>
        <Button size="small" startIcon={<DownloadOutlined />} disabled={!raw.current} onClick={download}>
          {t('download')}
        </Button>
      </Stack>

      <Stack direction="row" gap={1.5} flexWrap="wrap" alignItems="center">
        <ToggleButtonGroup size="small" exclusive value={minLevel} onChange={(_, v) => v && setMinLevel(v)}>
          <ToggleButton value="ALL">{t('allLevels')}</ToggleButton>
          <ToggleButton value="WARNING">
            WARNING+ ({(counts.WARNING ?? 0) + (counts.ERROR ?? 0) + (counts.FATAL ?? 0) + (counts.PANIC ?? 0)})
          </ToggleButton>
          <ToggleButton value="ERROR">
            ERROR+ ({(counts.ERROR ?? 0) + (counts.FATAL ?? 0) + (counts.PANIC ?? 0)})
          </ToggleButton>
        </ToggleButtonGroup>
        <TextField
          size="small"
          placeholder={t('searchLog')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ flex: 1, minWidth: 220 }}
        />
        <FormControlLabel
          control={<Switch size="small" checked={onlyMatches} onChange={(e) => setOnlyMatches(e.target.checked)} />}
          label={t('onlyMatches')}
        />
        <Typography variant="caption" color="text.secondary">
          {files.data?.log_directory ? `${files.data.log_directory}/` : ''}
          {file} · {formatBytes(meta.size)} · {t('entriesShown', { count: shown.length })}
        </Typography>
      </Stack>

      {files.error ? <Alert severity="error">{errorText(files.error)}</Alert> : null}
      {loadError ? <Alert severity="error">{loadError}</Alert> : null}

      <Box
        sx={{
          flex: 1,
          minHeight: 0,
          border: 1,
          borderColor: 'divider',
          borderRadius: 2,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          bgcolor: dark ? '#111418' : '#fbfbfc',
        }}>
        {chunkState.isFetching && !live ? <LinearProgress sx={{ height: 2 }} /> : <Box height={2} />}
        <Box
          ref={boxRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
          sx={{
            flex: 1,
            overflow: 'auto',
            fontFamily: '"JetBrains Mono", ui-monospace, monospace',
            fontSize: 12,
            lineHeight: 1.55,
            px: 1.5,
            py: 1,
          }}>
          {meta.truncated || hiddenOlder > 0 ? (
            <Typography variant="caption" color="text.secondary" component="div" mb={1}>
              {hiddenOlder > 0 ? t('olderHidden', { count: hiddenOlder }) : t('olderNotLoaded')}
            </Typography>
          ) : null}
          {shown.map((e) => {
            const c = LEVEL_COLORS[e.level];
            return (
              <Box
                key={e.seq}
                component="div"
                sx={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: c ? (dark ? c.dark : c.light) : 'text.primary',
                  fontWeight: e.level === 'FATAL' || e.level === 'PANIC' ? 700 : 400,
                  borderLeft: 3,
                  borderLeftColor: c ? (dark ? c.dark : c.light) : 'transparent',
                  pl: 1,
                  '&:hover': { bgcolor: 'action.hover' },
                }}>
                {highlight(e.text, q)}
              </Box>
            );
          })}
          {!shown.length && !chunkState.isFetching && !loadError ? (
            <Typography color="text.secondary" fontSize={13} p={2}>
              {t('noLogLines')}
            </Typography>
          ) : null}
        </Box>
      </Box>
    </Stack>
  );
};

export default PostgresLogs;
