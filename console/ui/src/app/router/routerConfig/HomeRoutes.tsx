import { FC, lazy } from 'react';
import { Navigate, Route } from 'react-router-dom';
import RouterPaths from '@app/router/routerPathsConfig';
import { useGetAuthMeQuery } from '@shared/api/api/auth.ts';
import Spinner from '@shared/ui/spinner';
import { safeStartPage } from '@pages/home/model/cards.ts';

const Home = lazy(() => import('@pages/home'));

/** "/" opens the start page the user chose (their home page by default) */
const StartPage: FC = () => {
  const me = useGetAuthMeQuery();
  if (me.isLoading) return <Spinner />;
  return <Navigate to={safeStartPage(me.data?.preferences?.home?.start_page)} replace />;
};

// pg_genin: everyone's own home page
const HomeRoutes = () => [
  <Route key="start" path="" element={<StartPage />} />,
  <Route
    key="home"
    path={RouterPaths.home.absolutePath}
    handle={{ breadcrumb: { label: 'home', ns: 'shared' } }}
    element={<Home />}
  />,
];

export default HomeRoutes;
