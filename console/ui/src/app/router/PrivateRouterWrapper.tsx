import { Navigate, Outlet, useLocation } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';
import { FC, useEffect } from 'react';
import { setDbdeskAuthCookie } from '@shared/lib/dbdeskAuthCookie.ts';
import { useGetAuthMeQuery } from '@shared/api/api/auth.ts';
import { getSessionUser, updateSessionUser } from '@shared/lib/session.ts';

const PrivateRouteWrapper: FC = () => {
  const location = useLocation();
  const token = localStorage.getItem('token');

  // pg_genin: effective permissions come from the access policies; refresh them on load and every minute so
  // policy changes show up without signing in again
  const me = useGetAuthMeQuery(undefined, { skip: !token, pollingInterval: 60_000, refetchOnFocus: true });
  useEffect(() => {
    if (me.data) updateSessionUser({ ...(getSessionUser() ?? {}), ...me.data });
  }, [me.data]);

  useEffect(() => {
    // Keep the SQL editor auth cookie in sync for validated sessions restored
    // from localStorage without exposing the expected token in the UI bundle.
    if (token) setDbdeskAuthCookie(token);
  }, [token]);

  // A token is stored only after it was validated against the API at login
  // (see pages/login). Enforcement is server-side: every API call carries the
  // bearer and the backend rejects an invalid one with 401.
  return token ? (
    <Outlet />
  ) : (
    <Navigate to={RouterPaths.login.absolutePath} replace state={{ path: location.pathname }} />
  );
};

export default PrivateRouteWrapper;
