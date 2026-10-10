/**
 * pg_genie SQL editor: per-user browser storage for query tabs and run history. This is a convenience only
 * (it stays in this browser); every access is guarded so the editor works without storage.
 */
import { getSessionUser } from '@shared/lib/session.ts';

export interface QueryTab {
  id: string;
  title: string;
  sql: string;
}

export interface HistoryEntry {
  at: string; // ISO time
  clusterId: number;
  clusterName: string;
  database: string;
  sql: string;
  ok: boolean;
  durationMs?: number;
  summary: string; // e.g. "SELECT 20" or the error message
}

const key = (what: string) => `jumbosql.sqlEditor.${what}.${getSessionUser()?.username ?? 'anon'}`;

const read = <T>(what: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key(what));
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

const write = (what: string, value: unknown) => {
  try {
    localStorage.setItem(key(what), JSON.stringify(value));
  } catch {
    /* storage full or blocked: keep working in memory */
  }
};

export const newTabId = () => Math.random().toString(36).slice(2, 10);

export const loadTabs = (): QueryTab[] => {
  const tabs = read<QueryTab[]>('tabs', []);
  return tabs.length ? tabs : [{ id: newTabId(), title: 'Query 1', sql: '' }];
};
export const saveTabs = (tabs: QueryTab[]) => write('tabs', tabs);

export const loadActiveTab = () => read<string>('activeTab', '');
export const saveActiveTab = (id: string) => write('activeTab', id);

export const loadSelection = () => read<{ clusterId?: number; database?: string }>('selection', {});
export const saveSelection = (s: { clusterId?: number; database?: string }) => write('selection', s);

const HISTORY_MAX = 200;
export const loadHistory = () => read<HistoryEntry[]>('history', []);
export const addHistory = (e: HistoryEntry): HistoryEntry[] => {
  const next = [e, ...loadHistory()].slice(0, HISTORY_MAX);
  write('history', next);
  return next;
};
export const clearHistory = () => write('history', []);
