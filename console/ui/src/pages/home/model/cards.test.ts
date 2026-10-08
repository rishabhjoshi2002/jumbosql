import { describe, expect, it } from 'vitest';
import { SessionUser } from '@shared/lib/session.ts';
import { availableCards, chosenCards, defaultCards, safeStartPage } from './cards';

const user = (global: string[]): SessionUser => ({ username: 'rishabh', permissions: { global, clusters: {} } });

describe('home page cards', () => {
  it('offers only the cards the user may see', () => {
    const op = user(['clusters.view', 'sql.read']);
    expect(availableCards(op)).not.toContain('fleet');
    expect(defaultCards(op)).toEqual(['clusters', 'recentQueries', 'shortcuts', 'operations', 'notes']);
    const cto = user(['clusters.view', 'insights.view']);
    expect(defaultCards(cto)[0]).toBe('fleet');
  });
  it('keeps the chosen order and drops cards no longer allowed', () => {
    const op = user(['clusters.view']);
    expect(chosenCards({ home: { cards: ['notes', 'fleet', 'clusters'] } }, op)).toEqual(['notes', 'clusters']);
    expect(chosenCards({ home: { cards: [] } }, op)).toEqual([]);
    expect(chosenCards(undefined, op)).toEqual(defaultCards(op));
  });
  it('only starts on pages inside the console', () => {
    expect(safeStartPage('/sql-editor')).toBe('/sql-editor');
    expect(safeStartPage('//evil.example')).toBe('/home');
    expect(safeStartPage('https://evil.example')).toBe('/home');
    expect(safeStartPage(undefined)).toBe('/home');
  });
});
