import { lazy } from 'react';
import { Route } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';
import RequirePermission from '@shared/ui/require-permission';

const AuditLog = lazy(() => import('@pages/audit'));
const PostgresLogs = lazy(() => import('@pages/postgres-logs'));
const Insights = lazy(() => import('@pages/insights'));

// pg_genin: audit log (audit.view) and PostgreSQL server logs (logs.view)
const AccessRoutes = () => [
  <Route
    key="audit"
    path={RouterPaths.audit.absolutePath}
    handle={{ breadcrumb: { label: 'auditLog', ns: 'shared' } }}
    element={
      <RequirePermission perms={['audit.view']}>
        <AuditLog />
      </RequirePermission>
    }
  />,
  <Route
    key="insights"
    path={RouterPaths.insights.absolutePath}
    handle={{ breadcrumb: { label: 'title', ns: 'insights' } }}
    element={
      <RequirePermission perms={['insights.view']}>
        <Insights />
      </RequirePermission>
    }
  />,
  <Route
    key="logs"
    path={RouterPaths.logs.absolutePath}
    handle={{ breadcrumb: { label: 'postgresLogs', ns: 'shared' } }}
    element={
      <RequirePermission perms={['logs.view']}>
        <PostgresLogs />
      </RequirePermission>
    }
  />,
];

export default AccessRoutes;
