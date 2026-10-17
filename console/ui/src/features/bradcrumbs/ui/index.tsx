import { FC } from 'react';
import { Breadcrumbs as MaterialBreadcrumbs, Link as MuiLink, Typography } from '@mui/material';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import useBreadcrumbs from '@/features/bradcrumbs/hooks/useBreadcrumbs.tsx';
import RouterPaths from '@app/router/routerPathsConfig';

/**
 * Where you are, in words only: "Home › Backup & Restore". Home always opens the home page; on the home page
 * itself there is just "Home" (never "Home / Home"). Every part but the last is a link.
 */
const Breadcrumbs: FC = () => {
  const { t } = useTranslation('shared');
  const home = RouterPaths.home.absolutePath;
  const crumbs = useBreadcrumbs().filter((c) => c.path !== home && c.path !== `${home}/`);
  const all = [{ label: t('home'), path: home }, ...crumbs];

  return (
    <MaterialBreadcrumbs separator={<NavigateNextIcon sx={{ fontSize: 18, color: 'text.disabled' }} />}>
      {all.map((c, i) =>
        i === all.length - 1 ? (
          <Typography key={c.path} color="text.primary" fontWeight={700} fontSize={14}>
            {c.label}
          </Typography>
        ) : (
          <MuiLink
            key={c.path}
            component={Link}
            to={c.path}
            underline="hover"
            color="text.secondary"
            fontWeight={600}
            fontSize={14}>
            {c.label}
          </MuiLink>
        ),
      )}
    </MaterialBreadcrumbs>
  );
};

export default Breadcrumbs;
