import { describe, expect, it } from 'vitest';
import { apiErrorText } from './apiError.ts';

describe('apiErrorText', () => {
  it('reads the console error payload', () => {
    expect(apiErrorText({ data: { code: 100, title: 'no stanza', description: 'no stanza' } })).toBe('no stanza');
    expect(apiErrorText({ data: { message: 'bad' } })).toBe('bad');
    expect(apiErrorText({ error: 'TypeError: Failed to fetch' })).toBe('TypeError: Failed to fetch');
    expect(apiErrorText(undefined, 'x')).toBe('x');
  });
});
