/**
 * JumboSQL SQL editor: script helpers (no React). Statement splitting follows PostgreSQL's lexical rules closely
 * enough for an editor: '...' and E'...' strings, "quoted identifiers", $tag$ dollar quotes $tag$, -- line and
 * nested block comments. Statements end at a semicolon outside all of those.
 */

export interface Statement {
  text: string; // trimmed statement text, without the trailing semicolon
  start: number; // offset of text[0] in the script
  end: number; // offset just after the statement (before the semicolon)
}

export const splitStatements = (sql: string): Statement[] => {
  const out: Statement[] = [];
  let i = 0;
  let segStart = 0;
  const n = sql.length;

  const push = (endExclusive: number) => {
    const raw = sql.slice(segStart, endExclusive);
    const lead = raw.length - raw.trimStart().length;
    const text = raw.trim();
    if (text && !isOnlyComments(text)) out.push({ text, start: segStart + lead, end: segStart + lead + text.length });
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
    } else if (c === "'") {
      const escapes = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[\w$]/.test(sql[i - 2]));
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
    } else if (c === '$' && (i === 0 || !/[\w$]/.test(sql[i - 1]))) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
      } else i++;
    } else if (c === ';') {
      push(i);
      i++;
      segStart = i;
    } else i++;
  }
  push(n);
  return out;
};

const isOnlyComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .trim() === '';

/** The statement under the cursor (or the one just before it, when the cursor is after a semicolon). */
export const statementAt = (sql: string, offset: number): Statement | undefined => {
  const all = splitStatements(sql);
  return all.find((s) => offset >= s.start && offset <= s.end + 1) ?? [...all].reverse().find((s) => s.start <= offset);
};

export const explainSql = (statement: string, analyze: boolean) =>
  `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}VERBOSE, FORMAT TEXT) ${statement.replace(/;\s*$/, '')}`;

/** 1-based line/column of a 1-based character offset (PostgreSQL error positions). */
export const offsetToLineCol = (text: string, position1: number) => {
  const upto = text.slice(0, Math.max(0, position1 - 1));
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
};

export const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

export const toCsv = (columns: string[], rows: (string | null | undefined)[][]) => {
  const cell = (v: string | null | undefined) =>
    v === null || v === undefined ? '' : /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  return [columns.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n') + '\r\n';
};

/** Short label for a result set tab: "SHOW", "SELECT 20", "INSERT 0 5" ... */
export const resultLabel = (commandTag: string | undefined, index: number) =>
  `${index + 1}: ${commandTag?.trim() || 'Result'}`;

/* ---------------- catalog queries for the object browser ---------------- */

export const SQL_DATABASES =
  'select datname from pg_database where datallowconn and not datistemplate order by datname = current_database() desc, datname';

export const SQL_SERVER_INFO =
  "select current_setting('server_version') as version, current_user as user, pg_size_pretty(pg_database_size(current_database())) as size, pg_is_in_recovery() as standby";

export const sqlSchemas = (system: boolean) =>
  `select nspname from pg_namespace where ${
    system
      ? "nspname !~ '^pg_(toast|temp_)'"
      : "nspname not in ('pg_catalog', 'information_schema') and nspname !~ '^pg_(toast|temp_|toast_temp_)'"
  } order by nspname`;

/** One query for a schema's objects: kind, name (functions with their argument list). */
export const sqlSchemaObjects = (schema: string) => `select kind, name from (
  select case c.relkind when 'r' then 'table' when 'p' then 'table' when 'f' then 'table' when 'v' then 'view'
              when 'm' then 'matview' when 'S' then 'sequence' end as kind, c.relname::text as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = ${quoteLiteral(schema)} and c.relkind in ('r', 'p', 'f', 'v', 'm', 'S') and not c.relispartition
  union all
  select case p.prokind when 'p' then 'procedure' else 'function' end,
         p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = ${quoteLiteral(schema)} and p.prokind in ('f', 'p')
) o order by kind, name`;

export const sqlColumns = (schema: string, table: string) =>
  `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as not_null,
          coalesce((select true from pg_index i where i.indrelid = a.attrelid and i.indisprimary and a.attnum = any(i.indkey)), false) as pk
     from pg_attribute a
    where a.attrelid = ${quoteLiteral(`${quoteIdent(schema)}.${quoteIdent(table)}`)}::regclass and a.attnum > 0 and not a.attisdropped
    order by a.attnum`;

export const sqlSelectRows = (schema: string, table: string, limit = 100) =>
  `SELECT * FROM ${quoteIdent(schema)}.${quoteIdent(table)} LIMIT ${limit};`;

export const sqlCountRows = (schema: string, table: string) =>
  `SELECT count(*) FROM ${quoteIdent(schema)}.${quoteIdent(table)};`;
