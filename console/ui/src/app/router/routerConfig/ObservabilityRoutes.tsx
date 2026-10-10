import { lazy } from 'react';
import { Route } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';

const Observability = lazy(() => import('@pages/observability'));

// pg_genie: Grafana, Prometheus and Alertmanager for every cluster
const ObservabilityRoutes = () => (
  <Route
    path={RouterPaths.observability.absolutePath}
    handle={{
      breadcrumb: { label: 'observability', ns: 'shared' },
    }}
    element={<Observability />}
  />
);

export default ObservabilityRoutes;
