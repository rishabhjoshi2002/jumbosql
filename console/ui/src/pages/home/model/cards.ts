import { canAny, SessionUser } from '@shared/lib/session.ts';
import { UserPreferences } from '@shared/api/api/auth.ts';

/** pg_genin home page: the cards a user can put on it. A card shows only with one of its permissions. */
export type HomeCardId =
  'fleet' | 'risks' | 'growth' | 'clusters' | 'recentQueries' | 'operations' | 'shortcuts' | 'notes';

export const HOME_CARDS: { id: HomeCardId; perms: string[]; wide?: boolean }[] = [
  { id: 'fleet', perms: ['insights.view'], wide: true },
  { id: 'risks', perms: ['insights.view'] },
  { id: 'growth', perms: ['insights.view'] },
  { id: 'clusters', perms: ['clusters.view'] },
  { id: 'recentQueries', perms: ['sql.read', 'sql.write', 'sql.admin'] },
  { id: 'operations', perms: ['clusters.view'] },
  { id: 'shortcuts', perms: [] },
  { id: 'notes', perms: [] },
];

/** the cards this user may use */
export const availableCards = (user: SessionUser | null) =>
  HOME_CARDS.filter((c) => !c.perms.length || canAny(c.perms, undefined, user)).map((c) => c.id);

/** what a new user sees: the fleet summary when they may see Insights, else their clusters */
export const defaultCards = (user: SessionUser | null): HomeCardId[] => {
  const ok = availableCards(user);
  const order: HomeCardId[] = ok.includes('fleet')
    ? ['fleet', 'risks', 'growth', 'recentQueries', 'shortcuts', 'operations']
    : ['clusters', 'recentQueries', 'shortcuts', 'operations', 'notes'];
  return order.filter((c) => ok.includes(c));
};

/** the user's cards in their order, dropping any they may no longer see */
export const chosenCards = (prefs: UserPreferences | undefined, user: SessionUser | null): HomeCardId[] => {
  const ok = availableCards(user);
  const mine = prefs?.home?.cards;
  if (!Array.isArray(mine)) return defaultCards(user);
  return mine.filter((c): c is HomeCardId => ok.includes(c as HomeCardId));
};

export const isWide = (id: HomeCardId) => !!HOME_CARDS.find((c) => c.id === id)?.wide;

/** a start page is a path inside the console */
export const safeStartPage = (p?: string) => (p && p.startsWith('/') && !p.startsWith('//') ? p : '/home');
