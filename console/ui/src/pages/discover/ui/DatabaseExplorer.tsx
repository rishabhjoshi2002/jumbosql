import { FC, ReactNode, useState } from 'react';
import { Alert, Box, Chip, MenuItem, Stack, Tab, Tabs, TextField, Tooltip, Typography } from '@mui/material';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import { useTranslation } from 'react-i18next';
import { DDatabase, DIndex, DInventory, DNode, DTable } from '@shared/api/api/discover.ts';
import { bytes, compact } from '@pages/insights/lib/format.ts';
import DataTable, { Col } from './DataTable.tsx';

export const CHECK_ICON: Record<string, ReactNode> = {
  critical: <ErrorOutlineIcon fontSize="small" color="error" />,
  warning: <WarningAmberIcon fontSize="small" color="warning" />,
  info: <InfoOutlinedIcon fontSize="small" color="info" />,
  ok: <CheckCircleOutlineIcon fontSize="small" color="success" />,
};

const yes = (b: boolean) => (b ? '✓' : '—');
const day = (s?: string) => (s ? new Date(s.replace(' ', 'T')).toLocaleDateString() : '—');

const Tile: FC<{ label: string; value: string; sub?: string; tone?: 'warning' | 'error' }> = ({
  label,
  value,
  sub,
  tone,
}) => (
  <Box
    sx={{
      border: 1,
      borderColor: tone ? `${tone}.main` : 'divider',
      borderRadius: 1.5,
      px: 1.5,
      py: 1,
      minWidth: 0,
      bgcolor: 'background.paper',
    }}>
    <Typography variant="caption" color="text.secondary" noWrap component="div">
      {label}
    </Typography>
    <Typography sx={{ fontSize: 20, fontWeight: 700, lineHeight: 1.3 }} noWrap>
      {value}
    </Typography>
    {sub ? (
      <Typography variant="caption" color="text.secondary" noWrap component="div">
        {sub}
      </Typography>
    ) : null}
  </Box>
);

/** the database to open first: the biggest one that is not "postgres" */
export const biggestDb = (dbs: DDatabase[]) =>
  [...dbs].sort(
    (a, b) => (a.name === 'postgres' ? 1 : 0) - (b.name === 'postgres' ? 1 : 0) || b.size_bytes - a.size_bytes,
  )[0]?.name ?? '';

/** status of a database for the overview: worst check */
export const dbStatus = (inv?: DInventory) => {
  const c = inv?.checks ?? [];
  return c.some((x) => x.status === 'critical') ? 'critical' : c.some((x) => x.status === 'warning') ? 'warning' : 'ok';
};

const Checks: FC<{ inv: DInventory }> = ({ inv }) => {
  const { t } = useTranslation('discover');
  return (
    <Stack divider={<Box sx={{ borderTop: 1, borderColor: 'divider' }} />}>
      {inv.checks.map((c, i) => (
        <Stack key={i} direction="row" gap={1.25} py={1}>
          <Box sx={{ pt: '1px' }}>{CHECK_ICON[c.status]}</Box>
          <Box minWidth={0}>
            <Typography variant="body2" fontWeight={700}>
              {c.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {c.detail}
            </Typography>
          </Box>
        </Stack>
      ))}
      {!inv.checks.length ? <Alert severity="success">{t('noChecks')}</Alert> : null}
    </Stack>
  );
};

/** Everything inside the databases of one server: what a migration has to move. */
const DatabaseExplorer: FC<{ node: DNode; db?: string; onDb?: (db: string) => void }> = ({ node, db, onDb }) => {
  const { t } = useTranslation('discover');
  const dbs = node.databases ?? [];
  const [own, setOwn] = useState(db ?? biggestDb(dbs));
  const name = db ?? own;
  const setName = (v: string) => (onDb ? onDb(v) : setOwn(v));
  const [tab, setTab] = useState('readiness');
  const d: DDatabase | undefined = dbs.find((x) => x.name === name) ?? dbs[0];
  const inv = d?.inventory;
  if (!d) return <Typography color="text.secondary">{t('noDatabases')}</Typography>;
  const c = inv?.counts ?? {};
  const file = (what: string) => `${node.name || node.host}-${d.name}-${what}`;

  const tableCols: Col<DTable>[] = [
    { key: 'name', label: t('c_table'), value: (r) => `${r.schema}.${r.name}`, mono: true },
    {
      key: 'kind',
      label: t('c_kind'),
      value: (r) => (r.unlogged ? `${r.kind}, unlogged` : r.kind),
      render: (r) => (
        <Stack direction="row" gap={0.5} alignItems="center" sx={{ whiteSpace: 'nowrap' }}>
          {r.kind}
          {r.unlogged ? (
            <Chip size="small" color="warning" variant="outlined" label="unlogged" sx={{ height: 20 }} />
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'rows',
      label: t('c_rows'),
      value: (r) => r.rows,
      render: (r) => compact(Math.round(r.rows)),
      align: 'right',
    },
    {
      key: 'total',
      label: t('c_total'),
      value: (r) => r.total_bytes,
      render: (r) => bytes(r.total_bytes),
      align: 'right',
    },
    {
      key: 'data',
      label: t('c_data'),
      value: (r) => r.table_bytes,
      render: (r) => bytes(r.table_bytes),
      align: 'right',
    },
    {
      key: 'idx',
      label: t('c_indexSize'),
      value: (r) => r.index_bytes,
      render: (r) => bytes(r.index_bytes),
      align: 'right',
    },
    { key: 'toast', label: 'TOAST', value: (r) => r.toast_bytes, render: (r) => bytes(r.toast_bytes), align: 'right' },
    { key: 'cols', label: t('c_columns'), value: (r) => r.columns, align: 'right' },
    {
      key: 'pk',
      label: t('c_pk'),
      value: (r) => (r.primary_key ? 'yes' : 'no'),
      render: (r) =>
        r.primary_key ? (
          '✓'
        ) : (
          <Chip size="small" color="error" variant="outlined" label={t('noPk')} sx={{ height: 20 }} />
        ),
    },
    { key: 'ri', label: t('c_replIdent'), value: (r) => r.replica_identity },
    {
      key: 'dead',
      label: t('c_dead'),
      value: (r) => (r.rows + r.dead_rows ? (100 * r.dead_rows) / (r.rows + r.dead_rows) : 0),
      render: (r) =>
        r.dead_rows ? `${compact(r.dead_rows)} (${((100 * r.dead_rows) / (r.rows + r.dead_rows)).toFixed(0)}%)` : '—',
      align: 'right',
    },
    {
      key: 'seq',
      label: t('c_seqScans'),
      value: (r) => r.seq_scans,
      render: (r) => compact(r.seq_scans),
      align: 'right',
    },
    { key: 'vac', label: t('c_lastVacuum'), value: (r) => r.last_vacuum ?? '', render: (r) => day(r.last_vacuum) },
    { key: 'owner', label: t('c_owner'), value: (r) => r.owner },
  ];
  const indexCols: Col<DIndex>[] = [
    { key: 'name', label: t('c_index'), value: (r) => `${r.schema}.${r.name}`, mono: true },
    { key: 'table', label: t('c_table'), value: (r) => r.table, mono: true },
    { key: 'method', label: t('c_method'), value: (r) => r.method },
    { key: 'size', label: t('c_size'), value: (r) => r.size_bytes, render: (r) => bytes(r.size_bytes), align: 'right' },
    {
      key: 'kind',
      label: t('c_type'),
      value: (r) => (r.primary ? 'primary key' : r.unique ? 'unique' : ''),
    },
    {
      key: 'scans',
      label: t('c_scans'),
      value: (r) => r.scans,
      render: (r) =>
        r.scans === 0 && !r.primary ? (
          <Chip size="small" color="warning" variant="outlined" label={t('unused')} sx={{ height: 20 }} />
        ) : (
          compact(r.scans)
        ),
      align: 'right',
    },
    {
      key: 'valid',
      label: t('c_valid'),
      value: (r) => (r.valid ? 'yes' : 'no'),
      render: (r) => (r.valid ? '✓' : <Chip size="small" color="error" label={t('invalid')} sx={{ height: 20 }} />),
    },
    { key: 'def', label: t('c_definition'), value: (r) => r.definition, mono: true },
  ];

  return (
    <Stack gap={2}>
      <Stack direction="row" gap={1.5} alignItems="center" flexWrap="wrap">
        <TextField
          select
          size="small"
          label={t('database')}
          value={d.name}
          onChange={(e) => setName(e.target.value)}
          sx={{ minWidth: 220 }}>
          {dbs.map((x) => (
            <MenuItem key={x.name} value={x.name}>
              <Stack direction="row" gap={1} alignItems="center" width="100%">
                <Box flex={1}>{x.name}</Box>
                <Typography variant="caption" color="text.secondary">
                  {bytes(x.size_bytes)}
                </Typography>
                {x.inventory ? CHECK_ICON[dbStatus(x.inventory)] : null}
              </Stack>
            </MenuItem>
          ))}
        </TextField>
        <Typography variant="body2" color="text.secondary">
          {[
            `${t('c_owner')} ${d.owner}`,
            d.encoding,
            inv?.collation ? `${inv.collation} (${inv.locale_provider})` : '',
            inv?.tablespace ? `${t('tablespace')} ${inv.tablespace}` : '',
            inv ? `${t('xidAge')} ${compact(inv.xid_age)}` : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
      </Stack>
      {d.error ? <Alert severity="warning">{d.error}</Alert> : null}
      {!inv ? (
        <Alert severity="info">{t('noInventory')}</Alert>
      ) : (
        <>
          <Box
            sx={{
              display: 'grid',
              gap: 1.25,
              gridTemplateColumns: { xs: 'repeat(2, 1fr)', md: 'repeat(4, 1fr)', xl: 'repeat(8, 1fr)' },
            }}>
            <Tile
              label={t('k_size')}
              value={bytes(d.size_bytes)}
              sub={t('inTables', { value: bytes(inv.user_data_bytes) })}
            />
            <Tile
              label={t('k_tables')}
              value={String(c.tables ?? 0)}
              sub={
                c.partitioned_tables
                  ? t('partitioned', { count: c.partitioned_tables, parts: c.partitions })
                  : t('k_rows', { value: compact(Math.round(inv.total_rows_estimate)) })
              }
            />
            <Tile label={t('k_indexes')} value={String(c.indexes ?? 0)} />
            <Tile label={t('k_schemas')} value={String(c.schemas ?? 0)} />
            <Tile label={t('k_views')} value={`${c.views ?? 0} / ${c.materialized_views ?? 0}`} sub={t('viewsSub')} />
            <Tile
              label={t('k_functions')}
              value={`${c.functions ?? 0} / ${c.procedures ?? 0}`}
              sub={t('functionsSub')}
            />
            <Tile
              label={t('k_noPk')}
              value={String(c.tables_without_primary_key ?? 0)}
              tone={c.tables_without_primary_key ? 'error' : undefined}
              sub={t('k_noPkSub')}
            />
            <Tile
              label={t('k_lo')}
              value={String(c.large_objects ?? 0)}
              tone={c.large_objects ? 'warning' : undefined}
              sub={t('k_loSub', { seq: c.sequences ?? 0, trg: c.triggers ?? 0 })}
            />
          </Box>
          {inv.partial?.length ? (
            <Alert severity="warning">
              {t('partialTitle')} {inv.partial.join(' · ')}
            </Alert>
          ) : null}
          <Tabs
            value={tab}
            onChange={(_, v) => setTab(v)}
            variant="scrollable"
            sx={{ borderBottom: 1, borderColor: 'divider', minHeight: 40, '& .MuiTab-root': { minHeight: 40 } }}>
            <Tab value="readiness" label={t('t_readiness')} />
            <Tab value="tables" label={`${t('t_tables')} (${inv.tables.length})`} />
            <Tab value="indexes" label={`${t('t_indexes')} (${inv.indexes.length})`} />
            <Tab value="schemas" label={`${t('t_schemas')} (${inv.schemas.length})`} />
            <Tab value="views" label={`${t('t_views')} (${inv.views.length})`} />
            <Tab value="functions" label={`${t('t_functions')} (${inv.functions.length})`} />
            <Tab value="sequences" label={`${t('t_sequences')} (${inv.sequences.length})`} />
            <Tab value="keys" label={`${t('t_keys')} (${inv.foreign_keys.length})`} />
            <Tab value="types" label={`${t('t_types')} (${inv.types.length + inv.triggers.length})`} />
            <Tab value="columns" label={t('t_columns')} />
            <Tab value="extensions" label={`${t('t_extensions')} (${d.extensions?.length ?? 0})`} />
          </Tabs>
          {inv.truncated?.length ? (
            <Typography variant="caption" color="text.secondary">
              {inv.truncated.join(' · ')}
            </Typography>
          ) : null}

          {tab === 'readiness' ? <Checks inv={inv} /> : null}
          {tab === 'tables' ? (
            <DataTable
              rows={inv.tables}
              cols={tableCols}
              name={file('tables')}
              empty={t('none')}
              initialSort={{ key: 'total', desc: true }}
              note={inv.largest_table ? t('largest', { name: inv.largest_table }) : undefined}
            />
          ) : null}
          {tab === 'indexes' ? (
            <DataTable
              rows={inv.indexes}
              cols={indexCols}
              name={file('indexes')}
              empty={t('none')}
              initialSort={{ key: 'size', desc: true }}
              note={t('indexNote', {
                unused: inv.indexes.filter((i) => i.scans === 0 && !i.primary).length,
                invalid: inv.indexes.filter((i) => !i.valid).length,
              })}
            />
          ) : null}
          {tab === 'schemas' ? (
            <DataTable
              rows={inv.schemas}
              name={file('schemas')}
              empty={t('none')}
              initialSort={{ key: 'size', desc: true }}
              cols={[
                { key: 'name', label: t('c_schema'), value: (r) => r.name, mono: true },
                { key: 'owner', label: t('c_owner'), value: (r) => r.owner },
                { key: 'tables', label: t('c_tables'), value: (r) => r.tables, align: 'right' },
                {
                  key: 'size',
                  label: t('c_size'),
                  value: (r) => r.size_bytes,
                  render: (r) => bytes(r.size_bytes),
                  align: 'right',
                },
              ]}
            />
          ) : null}
          {tab === 'views' ? (
            <DataTable
              rows={inv.views}
              name={file('views')}
              empty={t('none')}
              cols={[
                { key: 'name', label: t('c_view'), value: (r) => `${r.schema}.${r.name}`, mono: true },
                { key: 'kind', label: t('c_kind'), value: (r) => (r.materialized ? 'materialized view' : 'view') },
                {
                  key: 'pop',
                  label: t('c_populated'),
                  value: (r) => (r.materialized ? (r.populated ? 'yes' : 'no') : ''),
                },
                {
                  key: 'size',
                  label: t('c_size'),
                  value: (r) => r.size_bytes,
                  render: (r) => (r.materialized ? bytes(r.size_bytes) : '—'),
                  align: 'right',
                },
                { key: 'owner', label: t('c_owner'), value: (r) => r.owner },
              ]}
            />
          ) : null}
          {tab === 'functions' ? (
            <DataTable
              rows={inv.functions}
              name={file('functions')}
              empty={t('none')}
              cols={[
                { key: 'name', label: t('c_name'), value: (r) => `${r.schema}.${r.name}(${r.args})`, mono: true },
                { key: 'kind', label: t('c_kind'), value: (r) => r.kind },
                { key: 'lang', label: t('c_language'), value: (r) => r.language },
                {
                  key: 'sec',
                  label: t('c_secdef'),
                  value: (r) => (r.security_definer ? 'yes' : ''),
                  render: (r) => yes(r.security_definer),
                },
                { key: 'owner', label: t('c_owner'), value: (r) => r.owner },
              ]}
            />
          ) : null}
          {tab === 'sequences' ? (
            <DataTable
              rows={inv.sequences}
              name={file('sequences')}
              empty={t('none')}
              initialSort={{ key: 'used', desc: true }}
              cols={[
                { key: 'name', label: t('c_sequence'), value: (r) => `${r.schema}.${r.name}`, mono: true },
                { key: 'type', label: t('c_type'), value: (r) => r.data_type },
                { key: 'last', label: t('c_lastValue'), value: (r) => r.last_value || '—', align: 'right' },
                { key: 'max', label: t('c_maxValue'), value: (r) => r.max_value, align: 'right' },
                {
                  key: 'used',
                  label: t('c_used'),
                  value: (r) => r.used_pct,
                  render: (r) => (
                    <Typography
                      variant="body2"
                      component="span"
                      color={r.used_pct >= 75 ? 'error.main' : r.used_pct >= 50 ? 'warning.main' : undefined}>
                      {r.used_pct.toFixed(r.used_pct < 1 ? 4 : 1)}%
                    </Typography>
                  ),
                  align: 'right',
                },
                {
                  key: 'cycle',
                  label: t('c_cycle'),
                  value: (r) => (r.cycle ? 'yes' : ''),
                  render: (r) => yes(r.cycle),
                },
              ]}
            />
          ) : null}
          {tab === 'keys' ? (
            <DataTable
              rows={inv.foreign_keys}
              name={file('foreign-keys')}
              empty={t('none')}
              cols={[
                { key: 'table', label: t('c_table'), value: (r) => r.table, mono: true },
                { key: 'name', label: t('c_name'), value: (r) => r.name, mono: true },
                { key: 'ref', label: t('c_references'), value: (r) => r.references, mono: true },
                { key: 'def', label: t('c_definition'), value: (r) => r.definition, mono: true },
                {
                  key: 'idx',
                  label: t('c_indexed'),
                  value: (r) => (r.indexed ? 'yes' : 'no'),
                  render: (r) =>
                    r.indexed ? (
                      '✓'
                    ) : (
                      <Chip size="small" color="warning" variant="outlined" label={t('noIndex')} sx={{ height: 20 }} />
                    ),
                },
              ]}
            />
          ) : null}
          {tab === 'types' ? (
            <Stack gap={2.5}>
              <DataTable
                rows={inv.types}
                name={file('types')}
                empty={t('noTypes')}
                cols={[
                  { key: 'name', label: t('c_type'), value: (r) => `${r.schema}.${r.name}`, mono: true },
                  { key: 'kind', label: t('c_kind'), value: (r) => r.kind },
                  { key: 'detail', label: t('c_detail'), value: (r) => r.detail ?? '' },
                ]}
              />
              <DataTable
                rows={inv.triggers}
                name={file('triggers')}
                empty={t('noTriggers')}
                cols={[
                  { key: 'table', label: t('c_table'), value: (r) => r.table, mono: true },
                  { key: 'name', label: t('c_trigger'), value: (r) => r.name, mono: true },
                  { key: 'fn', label: t('c_function'), value: (r) => r.function, mono: true },
                  { key: 'en', label: t('c_state'), value: (r) => r.enabled },
                ]}
              />
              {inv.foreign_servers.length ? (
                <Typography variant="body2">
                  <b>{t('foreignServers')}:</b> {inv.foreign_servers.join(', ')}
                </Typography>
              ) : null}
            </Stack>
          ) : null}
          {tab === 'columns' ? (
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              {inv.column_types.map((x) => (
                <Tooltip key={x.type} title={t('columnsOfType', { count: x.columns })}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${x.type} · ${x.columns}`}
                    sx={{ fontFamily: 'monospace' }}
                  />
                </Tooltip>
              ))}
            </Stack>
          ) : null}
          {tab === 'extensions' ? (
            <Stack direction="row" gap={0.75} flexWrap="wrap">
              {(d.extensions ?? []).map((x) => (
                <Chip key={x} size="small" variant="outlined" label={x} sx={{ fontFamily: 'monospace' }} />
              ))}
              {!d.extensions?.length ? (
                <Typography variant="body2" color="text.secondary">
                  {t('noExtensions')}
                </Typography>
              ) : null}
            </Stack>
          ) : null}
        </>
      )}
    </Stack>
  );
};

export default DatabaseExplorer;
