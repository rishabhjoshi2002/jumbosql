/** Splits PostgreSQL log text into entries (a line plus its tab-indented / DETAIL / STATEMENT continuation lines). */

export const LEVELS = ['PANIC', 'FATAL', 'ERROR', 'WARNING', 'NOTICE', 'LOG', 'INFO', 'DEBUG'] as const;
export type Level = (typeof LEVELS)[number] | 'OTHER';

const SEVERITY: Record<string, number> = {
  PANIC: 0,
  FATAL: 1,
  ERROR: 2,
  WARNING: 3,
  NOTICE: 4,
  LOG: 5,
  INFO: 5,
  DEBUG: 6,
  OTHER: 5,
};

// "... LOG:  text", "... ERROR:  text", "DEBUG1:"; the prefix before it is free-form (log_line_prefix)
const LEVEL_RE = /(?:^|\s)(PANIC|FATAL|ERROR|WARNING|NOTICE|LOG|INFO|DEBUG[1-5]?):\s\s?/;
const CONTINUATION_RE = /(?:^|\s)(DETAIL|HINT|CONTEXT|STATEMENT|QUERY|LOCATION):\s\s?/;

export interface LogEntry {
  /** first line plus continuation lines */
  text: string;
  level: Level;
  /** position of the first line in the loaded text, stable while text is appended */
  seq: number;
}

export const parseLog = (text: string, startSeq = 0): LogEntry[] => {
  const out: LogEntry[] = [];
  let seq = startSeq;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const prev = out[out.length - 1];
    const isContinuation = /^[\t ]/.test(line) || (!LEVEL_RE.test(line) && CONTINUATION_RE.test(line));
    if (prev && isContinuation) {
      prev.text += '\n' + line;
      continue;
    }
    const m = LEVEL_RE.exec(line);
    const lvl = m ? (m[1].startsWith('DEBUG') ? 'DEBUG' : (m[1] as Level)) : 'OTHER';
    out.push({ text: line, level: lvl, seq: seq++ });
  }
  return out;
};

/** at least this severe: 'ERROR' keeps PANIC, FATAL and ERROR */
export const atLeast = (e: LogEntry, min: Level | 'ALL') => min === 'ALL' || SEVERITY[e.level] <= SEVERITY[min];

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
