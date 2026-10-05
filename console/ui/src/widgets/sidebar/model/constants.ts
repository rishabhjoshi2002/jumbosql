import { TFunction } from 'i18next';
import RouterPaths from '@app/router/routerPathsConfig';
import ClustersIcon from '@assets/clustersIcon.svg?react';
import OperationsIcon from '@assets/operationsIcon.svg?react';
import SettingsIcon from '@assets/settingsIcon.svg?react';
import SqlEditorIcon from '@assets/SqlEditorIcon.svg?react';
import GithubIcon from '@assets/githubIcon.svg?react';
import DocumentationIcon from '@assets/docsIcon.svg?react';
import SupportIcon from '@assets/supportIcon.svg?react';
import ObservabilityIcon from '@mui/icons-material/InsightsOutlined';

export const sidebarData = (t: TFunction) => {
  const items = [
    {
      icon: ClustersIcon,
      label: t('clusters', { ns: 'clusters' }),
      path: RouterPaths.clusters.absolutePath,
    },
  ];

  // JumboSQL: built-in SQL editor (pgAdmin-style query tool, runs through the console API)
  items.push({
    icon: SqlEditorIcon,
    label: t('sqlEditor', { ns: 'shared' }),
    path: RouterPaths.sqlEditor.absolutePath,
  });

  // JumboSQL: Grafana / Prometheus / Alertmanager per cluster
  items.push({
    icon: ObservabilityIcon,
    label: t('observability', { ns: 'shared' }),
    path: RouterPaths.observability.absolutePath,
  });

  items.push({
    icon: OperationsIcon,
    label: t('operations', { ns: 'operations' }),
    path: RouterPaths.operations.absolutePath,
  });

  items.push({
    icon: SettingsIcon,
    label: t('settings', { ns: 'settings' }),
    path: RouterPaths.settings.absolutePath,
  });

  return items;
};

export const sidebarLowData = (t: TFunction) => [
  {
    icon: GithubIcon,
    label: t('github', { ns: 'shared' }),
    path: 'https://github.com/rishabhjoshi2002/jumbosql',
  },
  {
    icon: DocumentationIcon,
    label: t('documentation', { ns: 'shared' }),
    path: 'https://github.com/rishabhjoshi2002/jumbosql#readme',
  },
  {
    icon: SupportIcon,
    label: t('support', { ns: 'shared' }),
    path: 'https://github.com/rishabhjoshi2002/jumbosql/issues',
  },
];

export const OPEN_SIDEBAR_WIDTH = '220px';

export const COLLAPSED_SIDEBAR_WIDTH = '60px';
