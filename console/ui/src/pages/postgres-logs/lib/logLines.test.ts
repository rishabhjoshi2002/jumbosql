import { describe, expect, it } from 'vitest';
import { atLeast, parseLog } from './logLines';

const sample = [
  '2026-10-06 10:00:00 UTC [100-1] 10.0.0.5(5432) app@shop ERROR:  relation "x" does not exist at character 15',
  '2026-10-06 10:00:00 UTC [100-2] 10.0.0.5(5432) app@shop STATEMENT:  select * from x;',
  '2026-10-06 10:00:01 UTC [101-1]  LOG:  checkpoint starting: time',
  '2026-10-06 10:00:02 UTC [102-1]  FATAL:  password authentication failed for user "bob"',
  '2026-10-06 10:00:02 UTC [102-2]  DETAIL:  Connection matched pg_hba.conf line 5',
  '\tcontinued line',
  '2026-10-06 10:00:03 UTC [103-1]  DEBUG2:  something',
  '',
].join('\n');

describe('parseLog', () => {
  const e = parseLog(sample);
  it('groups continuation lines with their entry', () => {
    expect(e).toHaveLength(4);
    expect(e[0].level).toBe('ERROR');
    expect(e[0].text).toContain('STATEMENT:  select * from x;');
    expect(e[2].level).toBe('FATAL');
    expect(e[2].text.split('\n')).toHaveLength(3);
    expect(e[3].level).toBe('DEBUG');
    expect(e.map((x) => x.seq)).toEqual([0, 1, 2, 3]);
  });
  it('filters by minimum severity', () => {
    expect(e.filter((x) => atLeast(x, 'ERROR')).map((x) => x.level)).toEqual(['ERROR', 'FATAL']);
    expect(e.filter((x) => atLeast(x, 'ALL'))).toHaveLength(4);
    expect(e.filter((x) => atLeast(x, 'LOG'))).toHaveLength(3);
  });
});
