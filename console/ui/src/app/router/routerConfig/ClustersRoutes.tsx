import { lazy } from 'react';
import { Route } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';

const Clusters = lazy(() => import('@pages/clusters'));
const AddCluster = lazy(() => import('@pages/add-cluster'));
const OverviewCluster = lazy(() => import('@pages/overview-cluster'));

const ClustersRoutes = () => (
  <Route>
    <Route
      path={RouterPaths.clusters.absolutePath}
      handle={{
        breadcrumb: { label: 'clusters', ns: 'clusters' },
      }}>
      <Route path="" element={<Clusters />} />
      <Route
        path={RouterPaths.clusters.add.relativePath}
        handle={{
          breadcrumb: { label: 'createCluster', ns: 'clusters' },
        }}
        element={<AddCluster />}
      />
      <Route
        path={RouterPaths.clusters.overview.relativePath}
        handle={{
          breadcrumb: { label: 'overview', ns: 'shared' },
        }}
        element={<OverviewCluster />}
      />
    </Route>
  </Route>
);

export default ClustersRoutes;
