import { FC, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import DownloadIcon from '@mui/icons-material/DownloadOutlined';
import ContentCopyIcon from '@mui/icons-material/ContentCopyOutlined';
import { useTranslation } from 'react-i18next';
import { SqlRunResponse } from '@shared/api/api/sql.ts';
import ResultGrid from './ResultGrid.tsx';
import { resultLabel, toCsv } from '../lib/script.ts';
import { HistoryEntry } from '../lib/storage.ts';

interface Props {
  response?: SqlRunResponse;
  running: boolean;
  history: HistoryEntry[];
  onLoadHistory: (e: HistoryEntry) => void;
  onClearHistory: () => void;
  /** max rows the access policies allow (0 = no limit) */
  rowCap?: number;
}

const fmtMs = (ms?: number) =>
  ms === undefined ? '' : ms < 1000 ? `${ms.toFixed(ms < 10 ? 2 : 0)} ms` : `${(ms / 1000).toFixed(2)} s`;

const download = (name: string, text: string) => {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

const ResultsPanel: FC<Props> = ({ response, running, history, onLoadHistory, onClearHistory, rowCap = 0 }) => {
  const { t } = useTranslation('shared');
  const [tab, setTab] = useState<'data' | 'messages' | 'history'>('data');
  const sets = useMemo(() => (response?.results ?? []).filter((r) => (r.columns?.length ?? 0) > 0), [response]);
  const [active, setActive] = useState(0);

  // new response: show the last result set (like psql / pgAdmin), or the messages when nothing returned rows
  useEffect(() => {
    if (!response) return;
    setActive(Math.max(0, sets.length - 1));
    if (tab !== 'history') setTab(sets.length ? 'data' : 'messages');
    if (response.error) setTab(sets.length ? 'data' : 'messages');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [response]);

  const current = sets[Math.min(active, sets.length - 1)];

  const csv = () => {
    if (!current) return;
    download(
      `result-${current.statement ?? 1}.csv`,
      toCsv(
        (current.columns ?? []).map((c) => c.name ?? ''),
        current.rows ?? [],
      ),
    );
  };

  const statusLine = response
    ? response.error
      ? response.cancelled
        ? t('sqlCancelled')
        : t('sqlFailed')
      : t('sqlSucceeded', { time: fmtMs(response.duration_ms) })
    : running
      ? t('sqlRunning')
      : '';

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" alignItems="center" sx={{ borderBottom: 1, borderColor: 'divider', pr: 1 }}>
        <Tabs
          value={tab}
          onChange={(_, v) => setTab(v)}
          sx={{ minHeight: 36, '& .MuiTab-root': { minHeight: 36, py: 0 } }}>
          <Tab value="data" label={t('sqlDataOutput')} />
          <Tab
            value="messages"
            label={
              <Stack direction="row" gap="6px" alignItems="center">
                {t('sqlMessages')}
                {response?.error ? (
                  <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: 'error.main' }} />
                ) : null}
              </Stack>
            }
          />
          <Tab value="history" label={t('sqlHistory')} />
        </Tabs>
        <Box flex={1} />
        <Typography variant="caption" color={response?.error ? 'error' : 'text.secondary'} data-testid="sql-status">
          {statusLine}
        </Typography>
      </Stack>

      {tab === 'data' && (
        <Stack sx={{ flex: 1, minHeight: 0 }}>
          {sets.length > 1 && (
            <Stack direction="row" gap="6px" sx={{ px: 1, py: '6px', flexWrap: 'wrap' }}>
              {sets.map((s, i) => (
                <Chip
                  key={i}
                  size="small"
                  label={`${resultLabel(s.command_tag, (s.statement ?? i + 1) - 1)} (${s.row_count ?? 0})`}
                  color={i === active ? 'primary' : 'default'}
                  variant={i === active ? 'filled' : 'outlined'}
                  onClick={() => setActive(i)}
                />
              ))}
            </Stack>
          )}
          {current ? (
            <>
              <Box sx={{ flex: 1, minHeight: 0 }}>
                <ResultGrid key={`${response?.duration_ms}-${active}`} result={current} />
              </Box>
              <Stack
                direction="row"
                alignItems="center"
                gap="12px"
                sx={{ px: 1, py: '4px', borderTop: 1, borderColor: 'divider' }}>
                <Typography variant="caption" color="text.secondary">
                  {t('sqlRows', { count: current.row_count ?? 0 })} · {fmtMs(current.duration_ms ?? 0)}
                </Typography>
                {current.truncated ? (
                  <Typography variant="caption" color="warning.main">
                    {t(rowCap && (current.rows?.length ?? 0) >= rowCap ? 'sqlTruncatedByPolicy' : 'sqlTruncated', {
                      shown: current.rows?.length ?? 0,
                    })}
                  </Typography>
                ) : null}
                <Box flex={1} />
                <Button size="small" startIcon={<DownloadIcon />} onClick={csv}>
                  CSV
                </Button>
              </Stack>
            </>
          ) : (
            <Box sx={{ p: 2 }}>
              {response?.error ? (
                <Alert severity="error">{response.error.message}</Alert>
              ) : (
                <Typography color="text.secondary" variant="body2">
                  {response ? t('sqlNoRows') : t('sqlRunHint')}
                </Typography>
              )}
            </Box>
          )}
        </Stack>
      )}

      {tab === 'messages' && (
        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: 'auto',
            p: 1.5,
            fontFamily: '"JetBrains Mono", monospace',
            fontSize: '0.8rem',
          }}
          data-testid="sql-messages">
          {!response ? (
            <Typography color="text.secondary" variant="body2">
              {t('sqlRunHint')}
            </Typography>
          ) : (
            <Stack gap="4px">
              {response.server ? (
                <Box sx={{ color: 'text.secondary' }}>
                  -- {t('sqlRanOn', { server: response.server, database: response.database ?? '' })}
                </Box>
              ) : null}
              {(response.results ?? []).map((r, i) => (
                <Box key={i}>
                  {t('sqlStatementLine', {
                    n: r.statement ?? i + 1,
                    tag: r.command_tag || '',
                    rows: t('sqlRows', { count: r.row_count ?? 0 }),
                    time: fmtMs(r.duration_ms ?? 0),
                  })}
                  {r.truncated
                    ? `  (${t(rowCap && (r.rows?.length ?? 0) >= rowCap ? 'sqlTruncatedByPolicy' : 'sqlTruncated', { shown: r.rows?.length ?? 0 })})`
                    : ''}
                </Box>
              ))}
              {(response.notices ?? []).map((n, i) => (
                <Box key={`n${i}`} sx={{ color: 'info.main' }}>
                  {n}
                </Box>
              ))}
              {response.error ? (
                <Alert severity="error" sx={{ mt: 1, fontFamily: 'inherit', '& .MuiAlert-message': { width: '100%' } }}>
                  <Box sx={{ fontWeight: 700 }}>
                    {response.error.severity ? `${response.error.severity}:  ` : ''}
                    {response.error.message}
                  </Box>
                  {response.error.detail ? <Box>DETAIL: {response.error.detail}</Box> : null}
                  {response.error.hint ? <Box>HINT: {response.error.hint}</Box> : null}
                  {response.error.where ? <Box>CONTEXT: {response.error.where}</Box> : null}
                  <Box sx={{ color: 'text.secondary', mt: '4px' }}>
                    {response.error.sqlstate ? `SQL state: ${response.error.sqlstate}` : ''}
                    {response.error.statement ? `   ${t('sqlInStatement', { n: response.error.statement })}` : ''}
                    {response.error.position ? `   ${t('sqlAtCharacter', { n: response.error.position })}` : ''}
                  </Box>
                </Alert>
              ) : (
                <Box sx={{ mt: 1, color: 'success.main' }}>
                  {t('sqlSucceeded', { time: fmtMs(response.duration_ms) })}
                </Box>
              )}
            </Stack>
          )}
        </Box>
      )}

      {tab === 'history' && (
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {history.length ? (
            <>
              <Stack direction="row" justifyContent="flex-end" sx={{ px: 1, pt: '4px' }}>
                <Button size="small" onClick={onClearHistory}>
                  {t('sqlClearHistory')}
                </Button>
              </Stack>
              <Table size="small" stickyHeader>
                <TableHead>
                  <TableRow>
                    <TableCell>{t('sqlWhen')}</TableCell>
                    <TableCell>{t('sqlWhere')}</TableCell>
                    <TableCell>SQL</TableCell>
                    <TableCell>{t('sqlOutcome')}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {history.map((h, i) => (
                    <TableRow key={i} hover sx={{ cursor: 'pointer' }} onClick={() => onLoadHistory(h)}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(h.at).toLocaleString()}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {h.clusterName} / {h.database}
                      </TableCell>
                      <TableCell sx={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '0.75rem', maxWidth: 520 }}>
                        <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{h.sql}</Box>
                      </TableCell>
                      <TableCell sx={{ color: h.ok ? 'success.main' : 'error.main', whiteSpace: 'nowrap' }}>
                        {h.summary} {h.durationMs !== undefined ? `· ${fmtMs(h.durationMs)}` : ''}
                      </TableCell>
                      <TableCell padding="checkbox">
                        <Tooltip title={t('sqlCopy')}>
                          <ContentCopyIcon
                            fontSize="small"
                            onClick={(e) => {
                              e.stopPropagation();
                              void navigator.clipboard?.writeText(h.sql);
                            }}
                          />
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : (
            <Typography color="text.secondary" variant="body2" sx={{ p: 2 }}>
              {t('sqlNoHistory')}
            </Typography>
          )}
        </Box>
      )}
    </Stack>
  );
};

export default ResultsPanel;
