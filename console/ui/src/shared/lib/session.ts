import { clearDbdeskAuthCookie, setDbdeskAuthCookie } from '@shared/lib/dbdeskAuthCookie.ts';

/**
 * JumboSQL: the signed-in user. The session token goes where the console has always kept its token
 * (localStorage 'token', sent as Bearer by baseApi) and into the SQL editor cookie; the user's name and
 * role are kept for the header and for hiding admin-only screens. The API enforces roles either way.
 */
export interface SessionPermissions {
  /** permissions held globally, or (cluster-scoped ones) on at least one cluster */
  global: string[];
  /** cluster id -> cluster-scoped permissions there */
  clusters: Record<string, string[]>;
}

export interface SessionUser {
  id?: number;
  username: string;
  display_name?: string;
  /** legacy: the "group" attribute */
  role?: string;
  attributes?: Record<string, string>;
  /** effective permissions from the access policies (GET /auth/me) */
  permissions?: SessionPermissions;
  auth_provider?: string;
}

const USER_KEY = 'jumbosqlUser';

type Listener = () => void;
const listeners = new Set<Listener>();
let cached: { raw: string | null; user: SessionUser | null } = { raw: null, user: null };
const emit = () => listeners.forEach((l) => l());

/** subscribe to session changes (sign-in, refreshed permissions, sign-out) */
export const subscribeSession = (l: Listener) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const getSessionUser = (): SessionUser | null => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (raw === cached.raw) return cached.user; // stable snapshot for useSyncExternalStore
    cached = { raw, user: raw ? (JSON.parse(raw) as SessionUser) : null };
    return cached.user;
  } catch {
    return null;
  }
};

export const setSession = (token: string, user: SessionUser) => {
  localStorage.setItem('token', token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  setDbdeskAuthCookie(token);
  emit();
};

export const updateSessionUser = (user: SessionUser) => {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  emit();
};

export const clearSession = () => {
  localStorage.removeItem('token');
  localStorage.removeItem(USER_KEY);
  clearDbdeskAuthCookie();
  emit();
};

/**
 * Does the signed-in user have a permission - on a cluster (cluster-scoped permissions), or anywhere?
 * The API decides every request anyway; this only hides what would be refused.
 */
export const can = (perm: string, clusterId?: number | string | null, user: SessionUser | null = getSessionUser()) => {
  if (!user) return false;
  if (user.username === 'api-token') return true;
  const p = user.permissions;
  if (!p) return false;
  if (clusterId !== undefined && clusterId !== null && clusterId !== '') {
    return (p.clusters?.[String(clusterId)] ?? []).includes(perm);
  }
  return (p.global ?? []).includes(perm);
};

/** any of the permissions */
export const canAny = (
  perms: string[],
  clusterId?: number | string | null,
  user: SessionUser | null = getSessionUser(),
) => perms.some((perm) => can(perm, clusterId, user));

/** the user's group attribute (shown in the header), falling back to the legacy role */
export const userGroup = (user: SessionUser | null) => user?.attributes?.group ?? user?.role ?? '';
