import { TFunction } from 'i18next';
import RouterPaths from '@app/router/routerPathsConfig';
import ClustersIcon from '@assets/clustersIcon.svg?react';
import OperationsIcon from '@assets/operationsIcon.svg?react';
import SettingsIcon from '@assets/settingsIcon.svg?react';
import SqlEditorIcon from '@assets/SqlEditorIcon.svg?react';
import GithubIcon from '@assets/githubIcon.svg?react';
import DocumentationIcon from '@assets/docsIcon.svg?react';
import SupportIcon from '@assets/supportIcon.svg?react';
import ObservabilityIcon from '@mui/icons-material/MonitorHeartOutlined';
import PostgresLogsIcon from '@mui/icons-material/ReceiptLongOutlined';
import InsightsIcon from '@mui/icons-material/TipsAndUpdatesOutlined';
import AuditIcon from '@mui/icons-material/FactCheckOutlined';
import { canAny, getSessionUser, SessionUser } from '@shared/lib/session.ts';

// JumboSQL: menu items follow the user's access policies (perms: any one of them)
export const sidebarData = (t: TFunction, user: SessionUser | null = getSessionUser()) => {
  const all = [
    {
      icon: ClustersIcon,
      label: t('clusters', { ns: 'clusters' }),
      path: RouterPaths.clusters.absolutePath,
      perms: ['clusters.view'],
    },
    {
      icon: SqlEditorIcon,
      label: t('sqlEditor', { ns: 'shared' }),
      path: RouterPaths.sqlEditor.absolutePath,
      perms: ['sql.read', 'sql.write', 'sql.admin'],
    },
    {
      icon: ObservabilityIcon,
      label: t('observability', { ns: 'shared' }),
      path: RouterPaths.observability.absolutePath,
      perms: ['clusters.view'],
    },
    {
      icon: InsightsIcon,
      label: t('title', { ns: 'insights' }),
      path: RouterPaths.insights.absolutePath,
      perms: ['insights.view'],
    },
    {
      icon: PostgresLogsIcon,
      label: t('postgresLogs', { ns: 'shared' }),
      path: RouterPaths.logs.absolutePath,
      perms: ['logs.view'],
    },
    {
      icon: OperationsIcon,
      label: t('operations', { ns: 'operations' }),
      path: RouterPaths.operations.absolutePath,
      perms: ['clusters.view'],
    },
    {
      icon: AuditIcon,
      label: t('auditLog', { ns: 'shared' }),
      path: RouterPaths.audit.absolutePath,
      perms: ['audit.view'],
    },
    {
      icon: SettingsIcon,
      label: t('settings', { ns: 'settings' }),
      path: RouterPaths.settings.absolutePath,
      perms: ['settings.manage', 'clusters.manage', 'users.manage', 'policies.manage'],
    },
  ];
  return all
    .filter((item) => canAny(item.perms, undefined, user))
    .map((item) => ({ icon: item.icon, label: item.label, path: item.path }));
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
