import { lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';
import RequirePermission from '@shared/ui/require-permission';
import { getSettingsTabs } from '@pages/settings/model/constants.ts';

// the first settings tab the user's policies allow
const SettingsIndex = () => (
  <Navigate to={getSettingsTabs()[0]?.path ?? RouterPaths.settings.general.absolutePath} replace />
);

const Settings = lazy(() => import('@pages/settings'));
const SettingsForm = lazy(() => import('@widgets/settings-form'));
const SecretsTable = lazy(() => import('@widgets/secrets-table/ui'));
const ProjectsTable = lazy(() => import('@widgets/projects-table'));
const EnvironmentsTable = lazy(() => import('@widgets/environments-table'));
const UsersTable = lazy(() => import('@widgets/users-table'));
const PoliciesPage = lazy(() => import('@widgets/policies'));

const SettingsRoutes = () => (
  <Route>
    <Route
      path={RouterPaths.settings.absolutePath}
      handle={{
        breadcrumb: { label: 'settings', ns: 'settings' },
      }}
      element={<Settings />}>
      <Route path="" element={<SettingsIndex />}></Route>
      <Route
        path={RouterPaths.settings.general.relativePath}
        element={
          <RequirePermission perms={['settings.manage']}>
            <SettingsForm />
          </RequirePermission>
        }
      />
      <Route
        path={RouterPaths.settings.secrets.relativePath}
        element={
          <RequirePermission perms={['settings.manage', 'clusters.manage']}>
            <SecretsTable />
          </RequirePermission>
        }
      />
      <Route
        path={RouterPaths.settings.projects.relativePath}
        element={
          <RequirePermission perms={['settings.manage']}>
            <ProjectsTable />
          </RequirePermission>
        }
      />
      <Route
        path={RouterPaths.settings.environments.relativePath}
        element={
          <RequirePermission perms={['settings.manage']}>
            <EnvironmentsTable />
          </RequirePermission>
        }
      />
      <Route
        path={RouterPaths.settings.users.relativePath}
        element={
          <RequirePermission perms={['users.manage']}>
            <UsersTable />
          </RequirePermission>
        }
      />
      <Route
        path={RouterPaths.settings.policies.relativePath}
        element={
          <RequirePermission perms={['policies.manage']}>
            <PoliciesPage />
          </RequirePermission>
        }
      />
    </Route>
  </Route>
);

export default SettingsRoutes;
