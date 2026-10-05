import { FC, useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { MaterialReactTable, MRT_ColumnDef, useMaterialReactTable } from 'material-react-table';
import { SqlResultSet } from '@shared/api/api/sql.ts';

type Row = (string | null)[];

/** One result set as a scrollable, virtualized grid (no page limit), NULLs marked, cells selectable for copy. */
const ResultGrid: FC<{ result: SqlResultSet }> = ({ result }) => {
  const rows = useMemo(() => (result.rows ?? []) as Row[], [result.rows]);
  const columns = useMemo<MRT_ColumnDef<Row>[]>(
    () =>
      (result.columns ?? []).map((c, i) => ({
        id: `c${i}`,
        accessorFn: (r) => r[i],
        header: c.name || '?column?',
        Header: () => (
          <Box sx={{ lineHeight: 1.15, overflow: 'hidden' }}>
            <Typography component="div" sx={{ fontWeight: 700, fontSize: '0.8rem', whiteSpace: 'nowrap', textTransform: 'none' }}>
              {c.name || '?column?'}
            </Typography>
            <Typography component="div" sx={{ fontSize: '0.7rem', color: 'text.secondary', whiteSpace: 'nowrap', textTransform: 'none' }}>
              {c.type || ''}
            </Typography>
          </Box>
        ),
        size: Math.min(420, Math.max(110, (c.name?.length ?? 4) * 9 + 40)),
        Cell: ({ cell }) => {
          const v = cell.getValue<string | null>();
          return v === null || v === undefined ? (
            <Typography component="span" sx={{ color: 'text.disabled', fontStyle: 'italic', fontSize: 'inherit' }}>
              [null]
            </Typography>
          ) : (
            <Box component="span" sx={{ whiteSpace: 'pre', fontFamily: '"JetBrains Mono", monospace' }} title={v}>
              {v}
            </Box>
          );
        },
      })),
    [result.columns],
  );

  const table = useMaterialReactTable({
    columns,
    data: rows,
    enableRowNumbers: true,
    rowNumberDisplayMode: 'static',
    enableRowVirtualization: true,
    enableColumnVirtualization: columns.length > 30,
    enablePagination: false,
    enableColumnResizing: true,
    columnResizeMode: 'onEnd',
    layoutMode: 'grid',
    enableColumnActions: false,
    enableSorting: false,
    enableFilters: false,
    enableTopToolbar: false,
    enableBottomToolbar: false,
    enableStickyHeader: true,
    enableDensityToggle: false,
    initialState: { density: 'compact' },
    muiTablePaperProps: { elevation: 0, sx: { height: '100%', display: 'flex', flexDirection: 'column' } },
    muiTableContainerProps: { sx: { flex: 1, maxHeight: '100%' } },
    muiTableBodyCellProps: { sx: { fontSize: '0.8rem', userSelect: 'text', py: '2px' } },
    muiTableHeadCellProps: { sx: { py: '4px', verticalAlign: 'top', textTransform: 'none', letterSpacing: 0 } },
  });

  return (
    <Box sx={{ height: '100%', minHeight: 0 }} data-testid="sql-result-grid">
      <MaterialReactTable table={table} />
    </Box>
  );
};

export default ResultGrid;
