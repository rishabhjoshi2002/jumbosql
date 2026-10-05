import { clearDbdeskAuthCookie, setDbdeskAuthCookie } from '@shared/lib/dbdeskAuthCookie.ts';

/**
 * JumboSQL: the signed-in user. The session token goes where the console has always kept its token
 * (localStorage 'token', sent as Bearer by baseApi) and into the SQL editor cookie; the user's name and
 * role are kept for the header and for hiding admin-only screens. The API enforces roles either way.
 */
export interface SessionUser {
  id?: number;
  username: string;
  display_name?: string;
  role: 'admin' | 'operator' | 'viewer' | string;
  auth_provider?: string;
}

const USER_KEY = 'jumbosqlUser';

export const getSessionUser = (): SessionUser | null => {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
};

export const setSession = (token: string, user: SessionUser) => {
  localStorage.setItem('token', token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  setDbdeskAuthCookie(token);
};

export const updateSessionUser = (user: SessionUser) => localStorage.setItem(USER_KEY, JSON.stringify(user));

export const clearSession = () => {
  localStorage.removeItem('token');
  localStorage.removeItem(USER_KEY);
  clearDbdeskAuthCookie();
};

export const canManage = (user: SessionUser | null) => user?.role === 'admin' || user?.role === 'operator';
export const isAdmin = (user: SessionUser | null) => user?.role === 'admin';
