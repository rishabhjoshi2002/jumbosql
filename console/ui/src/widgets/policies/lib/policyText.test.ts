import { describe, expect, it } from 'vitest';
import { dataText, emptyPolicy, tidyPolicy, whenText, whereText, whoText } from './policyText';

describe('policy summaries', () => {
  const p = {
    ...emptyPolicy(),
    name: 'Analysts',
    subjects: { users: ['dave'], attributes: { team: ['analytics', 'bi'] } },
    resources: { environments: ['production'] },
    data: { databases: ['shop'], hidden_columns: ['*.*.email'], max_rows: 500 },
    conditions: {
      ip_ranges: ['10.0.0.0/8'],
      weekdays: [5, 1, 2, 3, 4],
      hours: '08:00-20:00',
      timezone: 'Asia/Kolkata',
    },
  };
  it('describes who, where, data and when', () => {
    expect(whoText(p)).toBe('users dave; team = analytics or bi');
    expect(whoText({ ...p, subjects: { everyone: true } })).toBe('Everyone');
    expect(whereText(p)).toBe('environment production');
    expect(whereText(emptyPolicy())).toBe('all clusters');
    expect(dataText(p)).toBe('databases shop · hides *.*.email · max 500 rows');
    expect(whenText(p)).toBe('from 10.0.0.0/8 Mon–Fri 08:00-20:00 (Asia/Kolkata)');
    expect(whenText({ ...p, conditions: { weekdays: [6, 7] } })).toBe('Sat, Sun');
  });

  it('tidies empty values away', () => {
    const t = tidyPolicy({
      ...emptyPolicy(),
      name: '  x ',
      subjects: { users: [' ', 'a '], attributes: { ' Team ': ['x', ''], empty: [] } },
      data: { tables: [], max_rows: 0 },
      conditions: { timezone: 'UTC' },
    });
    expect(t.name).toBe('x');
    expect(t.subjects).toEqual({ everyone: undefined, users: ['a'], attributes: { team: ['x'] } });
    expect(t.data.tables).toBeUndefined();
    expect(t.data.max_rows).toBeUndefined();
    expect(t.conditions.timezone).toBeUndefined(); // only kept with weekdays or hours
  });
});
