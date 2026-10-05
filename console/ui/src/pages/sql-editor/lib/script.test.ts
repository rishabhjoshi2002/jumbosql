import { describe, expect, it } from 'vitest';
import {
  explainSql,
  offsetToLineCol,
  quoteIdent,
  quoteLiteral,
  splitStatements,
  sqlColumns,
  statementAt,
  toCsv,
} from './script';

const texts = (sql: string) => splitStatements(sql).map((s) => s.text);

describe('splitStatements', () => {
  it('splits on semicolons and trims', () => {
    expect(texts('show hba_file;  show archive_command ;\nselect 1')).toEqual([
      'show hba_file',
      'show archive_command',
      'select 1',
    ]);
  });

  it('ignores semicolons in strings, identifiers, comments and dollar quotes', () => {
    const sql = `select 'a;b', "x;y", E'it\\'s;';
-- comment; here
/* block ; /* nested; */ still; */ select 2;
do $$ begin raise notice 'x;y'; end $$;
create function f() returns int language sql as $body$ select 1; $body$;
select $1;`;
    expect(texts(sql)).toEqual([
      `select 'a;b', "x;y", E'it\\'s;'`,
      '-- comment; here\n/* block ; /* nested; */ still; */ select 2',
      "do $$ begin raise notice 'x;y'; end $$",
      'create function f() returns int language sql as $body$ select 1; $body$',
      'select $1',
    ]);
  });

  it('drops empty and comment-only pieces and keeps offsets', () => {
    const sql = ';; -- only a comment\n;  select 1 ;';
    const st = splitStatements(sql);
    expect(st).toHaveLength(1);
    expect(sql.slice(st[0].start, st[0].end)).toBe('select 1');
  });
});

describe('statementAt', () => {
  const sql = 'select 1;\nselect 2;\nselect 3';
  it('finds the statement under the cursor', () => {
    expect(statementAt(sql, 0)?.text).toBe('select 1');
    expect(statementAt(sql, 12)?.text).toBe('select 2');
    expect(statementAt(sql, sql.length)?.text).toBe('select 3');
  });
  it('takes the statement just typed when the cursor is after its semicolon', () => {
    expect(statementAt('select 1;', 9)?.text).toBe('select 1');
  });
});

describe('helpers', () => {
  it('builds EXPLAIN', () => {
    expect(explainSql('select 1;', false)).toBe('EXPLAIN (VERBOSE, FORMAT TEXT) select 1');
    expect(explainSql('select 1', true)).toBe('EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT TEXT) select 1');
  });
  it('maps error positions to line and column', () => {
    expect(offsetToLineCol('select 1;\nselect * from nope', 25)).toEqual({ line: 2, column: 15 });
    expect(offsetToLineCol('selec 1', 1)).toEqual({ line: 1, column: 1 });
  });
  it('quotes identifiers and literals', () => {
    expect(quoteIdent('my"tab')).toBe('"my""tab"');
    expect(quoteLiteral("o'clock")).toBe("'o''clock'");
    expect(sqlColumns('public', "it's")).toContain(`'"public"."it''s"'::regclass`);
  });
  it('writes CSV with quoting and empty NULLs', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['1', null],
          ['x,y', 'say "hi"'],
        ],
      ),
    ).toBe('a,b\r\n1,\r\n"x,y","say ""hi"""\r\n');
  });
});
