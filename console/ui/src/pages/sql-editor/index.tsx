import '@pages/sql-editor/lib/monaco.ts';
import { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  IconButton,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import StopIcon from '@mui/icons-material/Stop';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import QueryStatsIcon from '@mui/icons-material/QueryStats';
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import { Editor, OnMount } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useAppSelector } from '@app/redux/store/hooks.ts';
import { selectActualTheme } from '@app/redux/slices/themeSlice/themeSelectors.ts';
import { selectCurrentProject } from '@app/redux/slices/projectSlice/projectSelectors.ts';
import { useGetClustersQuery } from '@shared/api/api/clusters.ts';
import {
  SqlRunResponse,
  usePostClustersByIdSqlCancelMutation,
  usePostClustersByIdSqlMutation,
} from '@shared/api/api/sql.ts';
import { can, canAny } from '@shared/lib/session.ts';
import { useSessionUser } from '@shared/lib/useSession.ts';
import { SQLProfile, useGetSqlAccessQuery } from '@shared/api/api/access.ts';
import LockPersonOutlinedIcon from '@mui/icons-material/LockPersonOutlined';
import ObjectBrowser from './ui/ObjectBrowser.tsx';
import ResultsPanel from './ui/ResultsPanel.tsx';
import { explainSql, offsetToLineCol, SQL_DATABASES, SQL_SERVER_INFO, statementAt } from './lib/script.ts';
import AccessBadge from './ui/AccessBadge.tsx';
import {
  addHistory,
  clearHistory,
  HistoryEntry,
  loadActiveTab,
  loadHistory,
  loadSelection,
  loadTabs,
  newTabId,
  QueryTab,
  saveActiveTab,
  saveSelection,
  saveTabs,
} from './lib/storage.ts';

const MAX_ROWS = [100, 1000, 10000, 100000];
const SQL_PERMS = ['sql.read', 'sql.write', 'sql.admin'];
const SQL_KEYWORDS = (
  'select from where and or not in is null like ilike between exists case when then else end as join left right full ' +
  'inner outer cross on using group by order having limit offset distinct union all intersect except insert into values ' +
  'update set delete returning create alter drop table view materialized index sequence schema database function ' +
  'procedure trigger extension role user grant revoke on to with recursive begin commit rollback savepoint explain ' +
  'analyze verbose buffers vacuum reindex cluster truncate copy show reset primary key foreign references unique check ' +
  'default constraint cascade restrict if replace language returns setof table do declare true false current_date now'
).split(' ');

const errorMessage = (e: unknown) => {
  const err = e as { data?: { description?: string; title?: string }; error?: string; status?: number };
  return err?.data?.description || err?.data?.title || err?.error || `request failed (${err?.status ?? '?'})`;
};

const titleOf = (sql: string, fallback: string) => {
  const line = sql
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('--'));
  return line ? (line.length > 24 ? `${line.slice(0, 24)}…` : line) : fallback;
};

/**
 * JumboSQL SQL editor (pgAdmin-style query tool). Scripts run through the API on the cluster's HAProxy read-write
 * port, so on the current Patroni leader; every statement's result set, the messages and errors come back.
 */
const SqlEditor: FC = () => {
  const { t } = useTranslation(['shared', 'clusters']);
  const theme = useAppSelector(selectActualTheme);
  const projectId = useAppSelector(selectCurrentProject);
  const [params, setParams] = useSearchParams();
  const user = useSessionUser();
  const allowed = canAny(SQL_PERMS, undefined, user);

  const clusters = useGetClustersQuery(
    { projectId: Number(projectId), offset: 0, limit: 999_999_999 },
    { skip: !projectId },
  );
  const ready = useMemo(
    () =>
      (clusters.data?.data ?? []).filter(
        (c) => c.connection_info && Object.keys(c.connection_info).length && SQL_PERMS.some((p) => can(p, c.id, user)),
      ),
    [clusters.data, user],
  );

  const saved = useMemo(loadSelection, []);
  const [clusterId, setClusterId] = useState<number | undefined>(Number(params.get('cluster')) || saved.clusterId);
  const [database, setDatabase] = useState<string>(params.get('database') || saved.database || 'postgres');
  const [databases, setDatabases] = useState<string[]>([]);
  const [server, setServer] = useState<{
    version?: string;
    user?: string;
    size?: string;
    node?: string;
    standby?: boolean;
  }>();
  const cluster = ready.find((c) => c.id === clusterId);

  // what the access policies allow here: level, databases, data scope, limits (the API enforces the same)
  const clusterAccess = useGetSqlAccessQuery({ id: clusterId ?? 0 }, { skip: !cluster });
  const dbAccess = useGetSqlAccessQuery({ id: clusterId ?? 0, database }, { skip: !cluster || !database });
  const profile: SQLProfile | undefined = dbAccess.data ?? clusterAccess.data;

  useEffect(() => {
    if (!ready.length) return;
    if (!clusterId || !ready.some((c) => c.id === clusterId)) setClusterId(ready[0].id);
  }, [ready, clusterId]);

  useEffect(() => {
    if (clusterId) {
      saveSelection({ clusterId, database });
      if (params.get('cluster') !== String(clusterId) || params.get('database') !== database)
        setParams({ cluster: String(clusterId), database }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, database]);

  const [runSql] = usePostClustersByIdSqlMutation();
  const [cancelSql] = usePostClustersByIdSqlCancelMutation();

  /** catalog / helper queries (object browser, database list): not in history, not in the results panel */
  const catalog = useCallback(
    async (sql: string, db = database) => {
      if (!clusterId) return undefined;
      try {
        return await runSql({ id: clusterId, sql, database: db, max_rows: 5000, timeout_seconds: 60 }).unwrap();
      } catch (e) {
        return { error: { message: errorMessage(e) } } as SqlRunResponse;
      }
    },
    [clusterId, database, runSql],
  );

  // databases of the cluster, and server info for the chosen database
  useEffect(() => {
    if (!clusterId || !allowed || !clusterAccess.data) return;
    const apply = (list: string[]) => {
      setDatabases(list);
      if (list.length && !list.includes(database)) setDatabase(list.includes('postgres') ? 'postgres' : list[0]);
    };
    const available = clusterAccess.data.available_databases;
    if (available?.length || !clusterAccess.data.databases_error) {
      apply(available ?? []);
      return;
    }
    void catalog(SQL_DATABASES, database).then((res) =>
      apply((res?.results?.[0]?.rows ?? []).map((r) => r[0] ?? '').filter(Boolean)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterId, allowed, clusterAccess.data]);

  useEffect(() => {
    if (!clusterId || !allowed || !databases.includes(database)) return;
    void catalog(SQL_SERVER_INFO).then((res) => {
      const r = res?.results?.[0]?.rows?.[0];
      setServer(
        r
          ? { version: r[0] ?? '', user: r[1] ?? '', size: r[2] ?? '', standby: r[3] === 't', node: res?.server }
          : undefined,
      );
    });
  }, [clusterId, database, allowed, catalog, databases]);

  /* ---------------- tabs ---------------- */
  const [tabs, setTabs] = useState<QueryTab[]>(loadTabs);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const a = loadActiveTab();
    return tabs.some((x) => x.id === a) ? a : tabs[0].id;
  });
  useEffect(() => saveTabs(tabs), [tabs]);
  useEffect(() => saveActiveTab(activeTab), [activeTab]);
  const tab = tabs.find((x) => x.id === activeTab) ?? tabs[0];

  const addTab = (sql = '') => {
    const id = newTabId();
    setTabs((ts) => [...ts, { id, title: `Query ${ts.length + 1}`, sql }]);
    setActiveTab(id);
    return id;
  };
  const closeTab = (id: string) => {
    setTabs((ts) => {
      const rest = ts.filter((x) => x.id !== id);
      const next = rest.length ? rest : [{ id: newTabId(), title: 'Query 1', sql: '' }];
      if (id === activeTab) setActiveTab(next[Math.max(0, ts.findIndex((x) => x.id === id) - 1)]?.id ?? next[0].id);
      return next;
    });
  };
  const setSql = (sql: string) => setTabs((ts) => ts.map((x) => (x.id === tab.id ? { ...x, sql } : x)));

  /* ---------------- editor ---------------- */
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const names = useRef<Set<string>>(new Set());
  const completion = useRef<Monaco.IDisposable | null>(null);
  const actions = useRef<{ run: () => void; explain: (analyze: boolean) => void }>({
    run: () => {},
    explain: () => {},
  });
  useEffect(() => () => completion.current?.dispose(), []);

  const onMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco as unknown as typeof Monaco;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => actions.current.run());
    editor.addCommand(monaco.KeyCode.F5, () => actions.current.run());
    editor.addCommand(monaco.KeyCode.F7, () => actions.current.explain(false));
    editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => actions.current.explain(true));
    completion.current?.dispose();
    completion.current = monaco.languages.registerCompletionItemProvider('sql', {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: [
            ...SQL_KEYWORDS.map((k) => ({
              label: k.toUpperCase(),
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: k.toUpperCase(),
              range,
            })),
            ...[...names.current].map((n) => ({
              label: n,
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: /^[a-z_][a-z0-9_$]*$/.test(n) ? n : `"${n.replace(/"/g, '""')}"`,
              range,
            })),
          ],
        };
      },
    });
    editor.focus();
  };

  const insertText = (text: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    const sel = ed.getSelection();
    if (sel) ed.executeEdits('object-browser', [{ range: sel, text, forceMoveMarkers: true }]);
    ed.focus();
  };

  /* ---------------- running ---------------- */
  const [maxRows, setMaxRows] = useState(1000);
  const rowCap = profile?.max_rows || 0;
  const rowChoices = rowCap ? [...MAX_ROWS.filter((n) => n < rowCap), rowCap] : MAX_ROWS;
  const effectiveMaxRows = rowCap && maxRows > rowCap ? rowCap : maxRows;
  const [response, setResponse] = useState<SqlRunResponse>();
  const [running, setRunning] = useState(false);
  const runIdRef = useRef('');
  const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);

  const clearMarkers = () => {
    const model = editorRef.current?.getModel();
    if (model && monacoRef.current) monacoRef.current.editor.setModelMarkers(model, 'jumbosql', []);
  };

  /** offset: where `sql` starts in the editor (for error markers); null when it isn't editor text (EXPLAIN) */
  const execute = async (sql: string, offset: number | null) => {
    if (!clusterId || !sql.trim() || running) return;
    clearMarkers();
    const runId = Math.random().toString(36).slice(2);
    runIdRef.current = runId;
    setRunning(true);
    setResponse(undefined);
    let res: SqlRunResponse;
    try {
      res = await runSql({ id: clusterId, sql, database, max_rows: effectiveMaxRows, run_id: runId }).unwrap();
    } catch (e) {
      res = { error: { message: errorMessage(e) }, results: [] };
    }
    setRunning(false);
    setResponse(res);

    // mark the error position in the editor
    const pos = res.error?.position;
    const model = editorRef.current?.getModel();
    if (pos && offset !== null && model && monacoRef.current) {
      const fullText = model.getValue();
      const abs = offset + pos;
      const { line, column } = offsetToLineCol(fullText, abs);
      monacoRef.current.editor.setModelMarkers(model, 'jumbosql', [
        {
          startLineNumber: line,
          startColumn: column,
          endLineNumber: line,
          endColumn: model.getWordAtPosition({ lineNumber: line, column })?.endColumn ?? column + 1,
          message: res.error?.message ?? '',
          severity: monacoRef.current.MarkerSeverity.Error,
        },
      ]);
      editorRef.current?.revealLineInCenterIfOutsideViewport(line);
    }

    const last = res.results?.[res.results.length - 1];
    setHistory(
      addHistory({
        at: new Date().toISOString(),
        clusterId,
        clusterName: cluster?.name ?? String(clusterId),
        database,
        sql: sql.length > 4000 ? `${sql.slice(0, 4000)}…` : sql,
        ok: !res.error,
        durationMs: res.duration_ms,
        summary: res.error
          ? (res.error.sqlstate ? `${res.error.sqlstate} ` : '') + (res.error.message ?? '')
          : last?.command_tag || 'OK',
      }),
    );
  };

  /** Run: the selection if there is one, else the whole script (like pgAdmin) */
  const runMain = () => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const sel = ed.getSelection();
    if (sel && !sel.isEmpty()) {
      void execute(model.getValueInRange(sel), model.getOffsetAt(sel.getStartPosition()));
    } else {
      void execute(model.getValue(), 0);
    }
  };

  /** Explain: the selection, else the statement under the cursor */
  const runExplain = (analyze: boolean) => {
    const ed = editorRef.current;
    const model = ed?.getModel();
    if (!ed || !model) return;
    const sel = ed.getSelection();
    let stmt: string | undefined;
    if (sel && !sel.isEmpty()) stmt = model.getValueInRange(sel).trim();
    else {
      const pos = ed.getPosition();
      stmt = statementAt(model.getValue(), pos ? model.getOffsetAt(pos) : 0)?.text;
    }
    if (!stmt) return;
    void execute(explainSql(stmt, analyze), null);
  };
  actions.current = { run: runMain, explain: runExplain };

  const cancel = () => {
    if (clusterId && runIdRef.current) void cancelSql({ id: clusterId, run_id: runIdRef.current });
  };

  const openSql = (sql: string, runNow: boolean) => {
    const empty = !tab.sql.trim();
    if (empty) setSql(sql);
    else addTab(sql);
    if (runNow) setTimeout(() => void execute(sql, 0), 50);
  };

  /* ---------------- layout: draggable split ---------------- */
  const [editorPct, setEditorPct] = useState(45);
  const splitRef = useRef<HTMLDivElement | null>(null);
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const box = splitRef.current?.getBoundingClientRect();
    if (!box) return;
    const move = (ev: MouseEvent) =>
      setEditorPct(Math.min(85, Math.max(15, ((ev.clientY - box.top) / box.height) * 100)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!allowed) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6">{t('sqlEditor')}</Typography>
        <Alert severity="info" icon={<LockPersonOutlinedIcon />} sx={{ mt: 2, maxWidth: 720 }}>
          {t('sqlNoAccess')}
        </Alert>
      </Box>
    );
  }

  if (clusters.isSuccess && !ready.length) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography variant="h6">{t('sqlEditor')}</Typography>
        <Alert severity="info" sx={{ mt: 2, maxWidth: 720 }}>
          {t('sqlNoClusters')}
        </Alert>
      </Box>
    );
  }

  return (
    <Stack sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }} data-testid="sql-editor">
      {/* connection bar */}
      <Stack
        direction="row"
        alignItems="center"
        gap="10px"
        sx={{ px: 1.5, py: 1, borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
        <TextField
          select
          size="small"
          label={t('cluster', { ns: 'clusters' })}
          value={clusterId ?? ''}
          onChange={(e) => {
            setClusterId(Number(e.target.value));
            setDatabase('postgres');
          }}
          sx={{ minWidth: 200 }}>
          {ready.map((c) => (
            <MenuItem key={c.id} value={c.id}>
              {c.name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          size="small"
          label={t('sqlDatabase')}
          value={databases.includes(database) ? database : ''}
          onChange={(e) => setDatabase(e.target.value)}
          sx={{ minWidth: 170 }}>
          {databases.map((d) => (
            <MenuItem key={d} value={d}>
              {d}
            </MenuItem>
          ))}
          {!databases.length ? (
            <MenuItem disabled value="">
              {t('sqlNoDatabases')}
            </MenuItem>
          ) : null}
        </TextField>
        {server ? (
          <Stack direction="row" gap="6px" alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <Chip size="small" label={`PostgreSQL ${server.version}`} />
            {server.node ? (
              <Tooltip title={t('sqlEditorLeaderNote', { ns: 'clusters' })}>
                <Chip
                  size="small"
                  color={server.standby ? 'warning' : 'success'}
                  variant="outlined"
                  label={`${server.standby ? t('sqlStandby') : t('sqlLeader')} ${server.node}`}
                />
              </Tooltip>
            ) : null}
            <Chip size="small" variant="outlined" label={`${server.user} · ${server.size}`} />
          </Stack>
        ) : null}
        <Box flex={1} />
        {profile ? <AccessBadge profile={profile} database={database} /> : null}
        <Tooltip title={<Box sx={{ whiteSpace: 'pre-line' }}>{t('sqlHelp')}</Box>}>
          <HelpOutlineIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        </Tooltip>
      </Stack>

      <Stack direction="row" sx={{ flex: 1, minHeight: 0 }}>
        {/* object browser */}
        <Box sx={{ width: 290, flexShrink: 0, borderRight: 1, borderColor: 'divider', minHeight: 0 }}>
          {clusterId && databases.includes(database) ? (
            <ObjectBrowser
              key={`${clusterId}`}
              run={(sql) => catalog(sql)}
              database={database}
              reloadKey={`${clusterId}/${database}`}
              onOpen={openSql}
              onInsert={insertText}
              onNames={(list) => list.forEach((n) => names.current.add(n))}
            />
          ) : null}
        </Box>

        {/* query tool */}
        <Stack sx={{ flex: 1, minWidth: 0, minHeight: 0 }} ref={splitRef}>
          <Stack direction="row" alignItems="center" sx={{ borderBottom: 1, borderColor: 'divider', pr: 1 }}>
            <Tabs
              value={tab.id}
              onChange={(_, v) => setActiveTab(v)}
              variant="scrollable"
              scrollButtons="auto"
              sx={{ minHeight: 34, flex: 1, '& .MuiTab-root': { minHeight: 34, py: 0, textTransform: 'none' } }}>
              {tabs.map((x) => (
                <Tab
                  key={x.id}
                  value={x.id}
                  label={
                    <Stack direction="row" alignItems="center" gap="4px">
                      <span>{titleOf(x.sql, x.title)}</span>
                      <CloseIcon
                        sx={{ fontSize: 14, opacity: 0.6, '&:hover': { opacity: 1 } }}
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(x.id);
                        }}
                      />
                    </Stack>
                  }
                />
              ))}
            </Tabs>
            <Tooltip title={t('sqlNewTab')}>
              <IconButton size="small" onClick={() => addTab()}>
                <AddIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>

          {/* toolbar */}
          <Stack
            direction="row"
            alignItems="center"
            gap="8px"
            sx={{ px: 1, py: '6px', borderBottom: 1, borderColor: 'divider', flexWrap: 'wrap' }}>
            {running ? (
              <Button size="small" color="error" variant="contained" startIcon={<StopIcon />} onClick={cancel}>
                {t('sqlCancel')}
              </Button>
            ) : (
              <Tooltip title="F5 / Ctrl+Enter">
                <Button
                  size="small"
                  variant="contained"
                  startIcon={<PlayArrowIcon />}
                  onClick={runMain}
                  data-testid="sql-run">
                  {t('sqlRun')}
                </Button>
              </Tooltip>
            )}
            <Tooltip title="F7">
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<AccountTreeOutlinedIcon />}
                  disabled={running}
                  onClick={() => runExplain(false)}>
                  {t('sqlExplain')}
                </Button>
              </span>
            </Tooltip>
            <Tooltip title={`Shift+F7 · ${t('sqlExplainAnalyzeNote')}`}>
              <span>
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={<QueryStatsIcon />}
                  disabled={running}
                  onClick={() => runExplain(true)}>
                  {t('sqlExplainAnalyze')}
                </Button>
              </span>
            </Tooltip>
            <Box flex={1} />
            <TextField
              select
              size="small"
              label={t('sqlMaxRows')}
              value={effectiveMaxRows}
              onChange={(e) => setMaxRows(Number(e.target.value))}
              sx={{ width: 120 }}>
              {rowChoices.map((n) => (
                <MenuItem key={n} value={n}>
                  {n.toLocaleString()}
                </MenuItem>
              ))}
            </TextField>
          </Stack>

          <Box sx={{ height: `${editorPct}%`, minHeight: 80 }}>
            <Editor
              key={tab.id}
              language="sql"
              theme={theme === 'dark' ? 'vs-dark' : 'light'}
              value={tab.sql}
              onChange={(v) => setSql(v ?? '')}
              onMount={onMount}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                fontFamily: '"JetBrains Mono", monospace',
                scrollBeyondLastLine: false,
                automaticLayout: true,
                tabSize: 2,
                renderLineHighlight: 'all',
                quickSuggestions: { other: true, comments: false, strings: false },
              }}
            />
          </Box>
          <Box
            onMouseDown={startDrag}
            sx={{
              height: 6,
              cursor: 'row-resize',
              bgcolor: 'divider',
              flexShrink: 0,
              '&:hover': { bgcolor: 'primary.light' },
            }}
          />
          <Box sx={{ flex: 1, minHeight: 0 }}>
            <ResultsPanel
              response={response}
              running={running}
              rowCap={rowCap}
              history={history}
              onLoadHistory={(h) => {
                if (h.clusterId && ready.some((c) => c.id === h.clusterId)) setClusterId(h.clusterId);
                if (h.database) setDatabase(h.database);
                addTab(h.sql);
              }}
              onClearHistory={() => {
                clearHistory();
                setHistory([]);
              }}
            />
          </Box>
        </Stack>
      </Stack>
    </Stack>
  );
};

export default SqlEditor;
