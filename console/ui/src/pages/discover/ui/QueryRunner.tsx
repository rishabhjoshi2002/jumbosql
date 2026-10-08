import { FC, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  ListSubheader,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import PlayArrowRounded from '@mui/icons-material/PlayArrowRounded';
import { useTranslation } from 'react-i18next';
import { DResult, QueryResult, usePostDiscoverQueryMutation } from '@shared/api/api/discover.ts';
import { SUGGESTED_QUERIES } from '../lib/queries.ts';
import DataTable, { Col } from './DataTable.tsx';
import { biggestDb } from './DatabaseExplorer.tsx';

type Row = (string | null)[];

/** Run read-only queries on any server of the discovery: pick a suggested one or write your own. */
const QueryRunner: FC<{
  result: DResult;
  username: string;
  password: string;
  sslmode: string;
  onPassword: (p: string) => void;
  server?: string;
}> = ({ result, username, password, sslmode, onPassword, server }) => {
  const { t } = useTranslation('discover');
  const nodes = result.nodes.filter((n) => n.reachable && !n.external);
  const [nodeId, setNodeId] = useState(server && nodes.some((n) => n.id === server) ? server : (nodes[0]?.id ?? ''));
  const node = nodes.find((n) => n.id === nodeId) ?? nodes[0];
  const [db, setDb] = useState('');
  const database =
    db && node?.databases?.some((d) => d.name === db) ? db : biggestDb(node?.databases ?? []) || 'postgres';
  const [pick, setPick] = useState('');
  const [sql, setSql] = useState(SUGGESTED_QUERIES[0].sql);
  const [out, setOut] = useState<QueryResult | null>(null);
  const [err, setErr] = useState('');
  const [run, running] = usePostDiscoverQueryMutation();
  const groups = useMemo(() => [...new Set(SUGGESTED_QUERIES.map((q) => q.group))], []);
  const help = SUGGESTED_QUERIES.find((q) => q.title === pick)?.help;

  const go = async () => {
    if (!node) return;
    setErr('');
    try {
      setOut(
        await run({
          host: node.host,
          port: node.port,
          username,
          password,
          database,
          sslmode,
          sql,
          max_rows: 1000,
        }).unwrap(),
      );
    } catch (e) {
      setOut(null);
      setErr(String((e as { data?: { title?: string } }).data?.title ?? t('failed')));
    }
  };

  const cols: Col<Row>[] = (out?.columns ?? []).map((c, i) => ({
    key: `${i}`,
    label: c,
    value: (r) => {
      const v = r[i];
      return v !== null && v !== '' && !Number.isNaN(Number(v)) && v.length < 16 ? Number(v) : v;
    },
    render: (r) =>
      r[i] === null ? (
        <Typography component="span" variant="caption" color="text.disabled">
          NULL
        </Typography>
      ) : (
        r[i]
      ),
    mono: true,
  }));

  if (!nodes.length) return <Alert severity="info">{t('queryNoServers')}</Alert>;

  return (
    <Stack gap={1.5}>
      <Stack direction="row" gap={1} flexWrap="wrap" alignItems="center">
        <TextField
          select
          size="small"
          label={t('server')}
          value={node?.id ?? ''}
          onChange={(e) => setNodeId(e.target.value)}
          sx={{ minWidth: 230 }}>
          {nodes.map((n) => (
            <MenuItem key={n.id} value={n.id}>
              {n.name} · {n.id} · {t(`role_${n.role}`)}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('database')}
          value={database}
          onChange={(e) => setDb(e.target.value)}
          sx={{ minWidth: 160 }}>
          {(node?.databases ?? [{ name: 'postgres' }]).map((d) => (
            <MenuItem key={d.name} value={d.name}>
              {d.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('suggested')}
          value={pick}
          onChange={(e) => {
            setPick(e.target.value);
            const q = SUGGESTED_QUERIES.find((x) => x.title === e.target.value);
            if (q) setSql(q.sql);
          }}
          sx={{ minWidth: 320, flex: 1 }}>
          {groups.flatMap((g) => [
            <ListSubheader key={`h-${g}`}>{g}</ListSubheader>,
            ...SUGGESTED_QUERIES.filter((q) => q.group === g).map((q) => (
              <MenuItem key={q.title} value={q.title}>
                {q.title}
              </MenuItem>
            )),
          ])}
        </TextField>
        {!password ? (
          <TextField
            size="small"
            type="password"
            label={t('passwordFor', { user: username })}
            onChange={(e) => onPassword(e.target.value)}
            autoComplete="new-password"
            sx={{ width: 200 }}
          />
        ) : null}
      </Stack>
      {help ? (
        <Typography variant="caption" color="text.secondary">
          {help}
        </Typography>
      ) : null}
      <TextField
        multiline
        minRows={5}
        maxRows={18}
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            void go();
          }
        }}
        InputProps={{ sx: { fontFamily: '"JetBrains Mono", monospace', fontSize: 12.5 } }}
        spellCheck={false}
      />
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <Button
          variant="contained"
          startIcon={running.isLoading ? <CircularProgress size={16} color="inherit" /> : <PlayArrowRounded />}
          disabled={running.isLoading || !sql.trim() || !node}
          onClick={() => void go()}>
          {t('runQuery')}
        </Button>
        <Typography variant="caption" color="text.secondary" flex={1}>
          {t('queryNote')}
        </Typography>
        {out && !out.error ? (
          <Typography variant="caption" color="text.secondary">
            {t('queryStats', { rows: out.row_count, ms: out.duration_ms.toFixed(1) })}
            {out.truncated ? ` · ${t('queryTruncated', { shown: out.rows.length })}` : ''}
          </Typography>
        ) : null}
      </Stack>
      {err ? <Alert severity="warning">{err}</Alert> : null}
      {out?.error ? <Alert severity="error">{out.error}</Alert> : null}
      {out && !out.error ? (
        out.columns.length ? (
          <Box>
            <DataTable
              key={JSON.stringify(out.columns) + out.row_count}
              rows={out.rows}
              cols={cols}
              name={`${node?.name ?? 'query'}-${database}-${pick || 'query'}`}
              empty={t('noRows')}
            />
          </Box>
        ) : (
          <Alert severity="success">{t('queryDone')}</Alert>
        )
      ) : null}
    </Stack>
  );
};

export default QueryRunner;
