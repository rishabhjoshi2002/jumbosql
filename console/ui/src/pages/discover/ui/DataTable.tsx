import { ReactNode, useMemo, useState } from 'react';
import {
  Box,
  IconButton,
  InputAdornment,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TableSortLabel,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import DownloadOutlined from '@mui/icons-material/DownloadOutlined';
import { useTranslation } from 'react-i18next';

export type Col<T> = {
  key: string;
  label: string;
  /** value used for sorting, searching and CSV */
  value: (row: T) => string | number | boolean | null | undefined;
  /** what to show (default: the value) */
  render?: (row: T) => ReactNode;
  align?: 'left' | 'right';
  mono?: boolean;
  width?: number | string;
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const downloadCsv = (name: string, head: string[], rows: unknown[][]) => {
  const text = [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name.replace(/[^\w.-]+/g, '_')}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
};

/** A table that sorts (click a header), searches, pages and exports to CSV. */
function DataTable<T>({
  rows,
  cols,
  name,
  empty,
  initialSort,
  note,
  dense = true,
  maxHeight = 560,
}: {
  rows: T[];
  cols: Col<T>[];
  /** file name for the CSV */
  name: string;
  empty: string;
  initialSort?: { key: string; desc?: boolean };
  note?: ReactNode;
  dense?: boolean;
  maxHeight?: number;
}) {
  const { t } = useTranslation('discover');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(initialSort ?? { key: '', desc: false });
  const [page, setPage] = useState(0);
  const [per, setPer] = useState(50);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    let out = q
      ? rows.filter((r) =>
          cols.some((c) =>
            String(c.value(r) ?? '')
              .toLowerCase()
              .includes(q),
          ),
        )
      : [...rows];
    const col = cols.find((c) => c.key === sort.key);
    if (col) {
      out = out.sort((a, b) => {
        const x = col.value(a);
        const y = col.value(b);
        const r =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
        return sort.desc ? -r : r;
      });
    }
    return out;
  }, [rows, cols, search, sort]);

  return (
    <Box>
      <Stack direction="row" gap={1} alignItems="center" mb={1} flexWrap="wrap">
        <TextField
          size="small"
          placeholder={t('search')}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          sx={{ width: 280 }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize="small" />
              </InputAdornment>
            ),
          }}
        />
        <Typography variant="caption" color="text.secondary" flex={1}>
          {shown.length === rows.length
            ? t('rowsCount', { count: rows.length })
            : t('rowsFiltered', { shown: shown.length, count: rows.length })}
          {note ? <> · {note}</> : null}
        </Typography>
        <Tooltip title={t('exportCsv')}>
          <span>
            <IconButton
              size="small"
              disabled={!shown.length}
              onClick={() =>
                downloadCsv(
                  name,
                  cols.map((c) => c.label),
                  shown.map((r) => cols.map((c) => c.value(r))),
                )
              }>
              <DownloadOutlined fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      {rows.length ? (
        <>
          <TableContainer sx={{ maxHeight, border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
            <Table size={dense ? 'small' : 'medium'} stickyHeader>
              <TableHead>
                <TableRow>
                  {cols.map((c) => (
                    <TableCell key={c.key} align={c.align} sx={{ width: c.width, whiteSpace: 'nowrap' }}>
                      <TableSortLabel
                        active={sort.key === c.key}
                        direction={sort.key === c.key && sort.desc ? 'desc' : 'asc'}
                        onClick={() =>
                          setSort((s) => ({ key: c.key, desc: s.key === c.key ? !s.desc : c.align === 'right' }))
                        }>
                        {c.label}
                      </TableSortLabel>
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.slice(page * per, page * per + per).map((r, i) => (
                  <TableRow key={i} hover>
                    {cols.map((c, ci) => (
                      <TableCell
                        key={c.key}
                        align={c.align}
                        sx={{
                          whiteSpace:
                            ci === 0 || c.align === 'right' || (c.mono && c.key !== 'def') ? 'nowrap' : undefined,
                          minWidth: c.key === 'def' ? 340 : undefined,
                          fontFamily: c.mono ? '"JetBrains Mono", monospace' : undefined,
                          fontSize: c.mono ? 12 : undefined,
                          maxWidth: 460,
                          wordBreak: 'break-word',
                          verticalAlign: 'top',
                        }}>
                        {c.render ? c.render(r) : String(c.value(r) ?? '')}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {shown.length > 25 ? (
            <TablePagination
              component="div"
              count={shown.length}
              page={page}
              onPageChange={(_, p) => setPage(p)}
              rowsPerPage={per}
              onRowsPerPageChange={(e) => {
                setPer(Number(e.target.value));
                setPage(0);
              }}
              rowsPerPageOptions={[25, 50, 100, 500]}
            />
          ) : null}
        </>
      ) : (
        <Typography variant="body2" color="text.secondary" py={1}>
          {empty}
        </Typography>
      )}
    </Box>
  );
}

export default DataTable;
