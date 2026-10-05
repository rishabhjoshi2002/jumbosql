import { FC, ReactNode, useCallback, useEffect, useState } from 'react';
import {
  Box,
  CircularProgress,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Menu,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SearchIcon from '@mui/icons-material/Search';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import FunctionsIcon from '@mui/icons-material/Functions';
import NumbersIcon from '@mui/icons-material/Numbers';
import KeyIcon from '@mui/icons-material/VpnKeyOutlined';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import { useTranslation } from 'react-i18next';
import { SqlRunResponse } from '@shared/api/api/sql.ts';
import { quoteIdent, sqlColumns, sqlCountRows, sqlSchemaObjects, sqlSchemas, sqlSelectRows } from '../lib/script.ts';

type Run = (sql: string) => Promise<SqlRunResponse | undefined>;
type Obj = { kind: string; name: string };
type Col = { name: string; type: string; notNull: boolean; pk: boolean };

const KIND_ORDER = ['table', 'view', 'matview', 'function', 'procedure', 'sequence'];
const KIND_ICON: Record<string, ReactNode> = {
  table: <TableChartOutlinedIcon sx={{ fontSize: 16 }} />,
  view: <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />,
  matview: <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />,
  function: <FunctionsIcon sx={{ fontSize: 16 }} />,
  procedure: <FunctionsIcon sx={{ fontSize: 16 }} />,
  sequence: <NumbersIcon sx={{ fontSize: 16 }} />,
};

const rowsOf = (res?: SqlRunResponse) => res?.results?.[0]?.rows ?? [];

const Node: FC<{
  depth: number;
  label: ReactNode;
  icon?: ReactNode;
  open?: boolean;
  loading?: boolean;
  expandable?: boolean;
  onToggle?: () => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onDoubleClick?: () => void;
  title?: string;
}> = ({ depth, label, icon, open, loading, expandable, onToggle, onClick, onDoubleClick, title }) => (
  <Stack
    direction="row"
    alignItems="center"
    title={title}
    onClick={(e) => (onClick ? onClick(e) : onToggle?.())}
    onDoubleClick={onDoubleClick}
    sx={{
      pl: `${depth * 14 + 4}px`,
      pr: 1,
      py: '2px',
      cursor: 'pointer',
      borderRadius: 1,
      fontSize: '0.82rem',
      whiteSpace: 'nowrap',
      '&:hover': { bgcolor: 'action.hover' },
    }}>
    <Box
      sx={{ width: 18, display: 'grid', placeItems: 'center', color: 'text.secondary' }}
      onClick={(e) => {
        if (expandable && onClick) {
          e.stopPropagation();
          onToggle?.();
        }
      }}>
      {loading ? (
        <CircularProgress size={11} />
      ) : expandable ? (
        open ? (
          <ExpandMoreIcon sx={{ fontSize: 16 }} />
        ) : (
          <ChevronRightIcon sx={{ fontSize: 16 }} />
        )
      ) : null}
    </Box>
    {icon ? <Box sx={{ mr: '6px', display: 'grid', color: 'text.secondary' }}>{icon}</Box> : null}
    <Box sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</Box>
  </Stack>
);

interface Props {
  run: Run;
  database: string;
  reloadKey: string;
  onOpen: (sql: string, runNow: boolean) => void;
  onInsert: (text: string) => void;
  onNames: (names: string[]) => void;
}

const ObjectBrowser: FC<Props> = ({ run, database, reloadKey, onOpen, onInsert, onNames }) => {
  const { t } = useTranslation('shared');
  const [system, setSystem] = useState(false);
  const [filter, setFilter] = useState('');
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [objects, setObjects] = useState<Record<string, Obj[]>>({});
  const [columns, setColumns] = useState<Record<string, Col[]>>({});
  const [menu, setMenu] = useState<{ el: HTMLElement; schema: string; obj: Obj } | null>(null);

  const loadSchemas = useCallback(async () => {
    setSchemas(null);
    setError('');
    setObjects({});
    setColumns({});
    setOpen({});
    const res = await run(sqlSchemas(system));
    if (res?.error) setError(res.error.message ?? 'error');
    const list = rowsOf(res).map((r) => r[0] ?? '');
    setSchemas(list);
    onNames(list);
    // open "public" like pgAdmin users expect
    if (list.includes('public')) void toggleSchema('public', true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, system, database]);

  useEffect(() => {
    void loadSchemas();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [database, system, reloadKey]);

  const toggleSchema = async (schema: string, forceOpen = false) => {
    const k = `s:${schema}`;
    const willOpen = forceOpen || !open[k];
    setOpen((o) => ({ ...o, [k]: willOpen }));
    if (willOpen && !objects[schema]) {
      setLoading((l) => ({ ...l, [k]: true }));
      const res = await run(sqlSchemaObjects(schema));
      const objs = rowsOf(res).map((r) => ({ kind: r[0] ?? '', name: r[1] ?? '' }));
      setObjects((o) => ({ ...o, [schema]: objs }));
      onNames(objs.filter((o) => !['function', 'procedure'].includes(o.kind)).map((o) => o.name));
      setLoading((l) => ({ ...l, [k]: false }));
    }
  };

  const toggleTable = async (schema: string, table: string) => {
    const k = `t:${schema}.${table}`;
    const willOpen = !open[k];
    setOpen((o) => ({ ...o, [k]: willOpen }));
    if (willOpen && !columns[k]) {
      setLoading((l) => ({ ...l, [k]: true }));
      const res = await run(sqlColumns(schema, table));
      const cols = rowsOf(res).map((r) => ({
        name: r[0] ?? '',
        type: r[1] ?? '',
        notNull: r[2] === 't',
        pk: r[3] === 't',
      }));
      setColumns((c) => ({ ...c, [k]: cols }));
      onNames(cols.map((c) => c.name));
      setLoading((l) => ({ ...l, [k]: false }));
    }
  };

  const f = filter.trim().toLowerCase();
  const visible = (name: string) => !f || name.toLowerCase().includes(f);

  return (
    <Stack sx={{ height: '100%', minHeight: 0 }}>
      <Stack direction="row" alignItems="center" gap="4px" sx={{ p: 1, pb: '4px' }}>
        <TextField
          size="small"
          fullWidth
          placeholder={t('sqlFilterObjects')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
              sx: { fontSize: '0.82rem' },
            },
          }}
        />
        <Tooltip title={t('sqlRefresh')}>
          <IconButton size="small" onClick={() => void loadSchemas()}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Stack>
      <FormControlLabel
        sx={{ px: 1.5, '& .MuiTypography-root': { fontSize: '0.75rem', color: 'text.secondary' } }}
        control={<Switch size="small" checked={system} onChange={(e) => setSystem(e.target.checked)} />}
        label={t('sqlSystemSchemas')}
      />
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: '4px', pb: 1 }} data-testid="sql-object-browser">
        {error ? (
          <Typography color="error" variant="caption" sx={{ px: 1 }}>
            {error}
          </Typography>
        ) : null}
        {schemas === null ? <CircularProgress size={18} sx={{ m: 2 }} /> : null}
        {(schemas ?? []).map((schema) => {
          const sk = `s:${schema}`;
          const objs = objects[schema] ?? [];
          const matching = objs.filter((o) => visible(o.name));
          if (f && objects[schema] && !matching.length && !visible(schema)) return null;
          return (
            <Box key={schema}>
              <Node
                depth={0}
                expandable
                open={open[sk]}
                loading={loading[sk]}
                onToggle={() => void toggleSchema(schema)}
                onDoubleClick={() => onInsert(quoteIdent(schema))}
                icon={<FolderOutlinedIcon sx={{ fontSize: 16 }} />}
                label={<b>{schema}</b>}
              />
              {open[sk] &&
                KIND_ORDER.map((kind) => {
                  const ofKind = matching.filter((o) => o.kind === kind);
                  if (!ofKind.length) return null;
                  const gk = `g:${schema}:${kind}`;
                  const gOpen = open[gk] ?? (kind === 'table' || !!f);
                  return (
                    <Box key={kind}>
                      <Node
                        depth={1}
                        expandable
                        open={gOpen}
                        onToggle={() => setOpen((o) => ({ ...o, [gk]: !gOpen }))}
                        label={
                          <Typography component="span" sx={{ fontSize: 'inherit', color: 'text.secondary' }}>
                            {t(`sqlKind_${kind}`)} ({ofKind.length})
                          </Typography>
                        }
                      />
                      {gOpen &&
                        ofKind.map((o) => {
                          const tk = `t:${schema}.${o.name}`;
                          const isRel = ['table', 'view', 'matview'].includes(o.kind);
                          return (
                            <Box key={o.name}>
                              <Node
                                depth={2}
                                expandable={isRel}
                                open={open[tk]}
                                loading={loading[tk]}
                                icon={KIND_ICON[o.kind]}
                                label={o.name}
                                title={t('sqlObjectHelp')}
                                onToggle={() => isRel && void toggleTable(schema, o.name)}
                                onClick={isRel ? (e) => setMenu({ el: e.currentTarget, schema, obj: o }) : undefined}
                                onDoubleClick={() =>
                                  onInsert(
                                    isRel || o.kind === 'sequence'
                                      ? `${quoteIdent(schema)}.${quoteIdent(o.name)}`
                                      : `${quoteIdent(schema)}.${o.name}`,
                                  )
                                }
                              />
                              {open[tk] &&
                                (columns[tk] ?? []).map((c) => (
                                  <Node
                                    key={c.name}
                                    depth={3}
                                    icon={
                                      c.pk ? (
                                        <KeyIcon sx={{ fontSize: 14, color: 'warning.main' }} />
                                      ) : (
                                        <ViewColumnOutlinedIcon sx={{ fontSize: 14 }} />
                                      )
                                    }
                                    onDoubleClick={() => onInsert(quoteIdent(c.name))}
                                    label={
                                      <>
                                        {c.name}{' '}
                                        <Typography
                                          component="span"
                                          sx={{ fontSize: '0.72rem', color: 'text.secondary' }}>
                                          {c.type}
                                          {c.notNull ? ' not null' : ''}
                                        </Typography>
                                      </>
                                    }
                                  />
                                ))}
                            </Box>
                          );
                        })}
                    </Box>
                  );
                })}
            </Box>
          );
        })}
      </Box>
      <Menu anchorEl={menu?.el} open={!!menu} onClose={() => setMenu(null)}>
        {menu
          ? [
              <MenuItem
                key="rows"
                dense
                onClick={() => {
                  onOpen(sqlSelectRows(menu.schema, menu.obj.name), true);
                  setMenu(null);
                }}>
                {t('sqlViewRows')}
              </MenuItem>,
              <MenuItem
                key="count"
                dense
                onClick={() => {
                  onOpen(sqlCountRows(menu.schema, menu.obj.name), true);
                  setMenu(null);
                }}>
                {t('sqlCountRows')}
              </MenuItem>,
              <MenuItem
                key="cols"
                dense
                onClick={() => {
                  void toggleTable(menu.schema, menu.obj.name);
                  setMenu(null);
                }}>
                {t('sqlShowColumns')}
              </MenuItem>,
              <MenuItem
                key="name"
                dense
                onClick={() => {
                  onInsert(`${quoteIdent(menu.schema)}.${quoteIdent(menu.obj.name)}`);
                  setMenu(null);
                }}>
                {t('sqlInsertName')}
              </MenuItem>,
            ]
          : null}
      </Menu>
    </Stack>
  );
};

export default ObjectBrowser;
