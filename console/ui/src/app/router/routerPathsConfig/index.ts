import routerClustersPathsConfig from '@app/router/routerPathsConfig/routerClustersPathsConfig.ts';
import routerOperationsPathsConfig from '@app/router/routerPathsConfig/routerOperationsPathsConfig.ts';
import routerSettingsPathsConfig from '@app/router/routerPathsConfig/routerSettingsPathsConfig.ts';
import routerSqlEditorPathsConfig from '@app/router/routerPathsConfig/routerSqlEditorPathsConfig.ts';
import routerObservabilityPathsConfig from '@app/router/routerPathsConfig/routerObservabilityPathsConfig.ts';
import routerAuditPathsConfig from '@app/router/routerPathsConfig/routerAuditPathsConfig.ts';
import routerLogsPathsConfig from '@app/router/routerPathsConfig/routerLogsPathsConfig.ts';
import routerInsightsPathsConfig from '@app/router/routerPathsConfig/routerInsightsPathsConfig.ts';
import routerHomePathsConfig from '@app/router/routerPathsConfig/routerHomePathsConfig.ts';
import routerDiscoverPathsConfig from '@app/router/routerPathsConfig/routerDiscoverPathsConfig.ts';
import routerUpgradePathsConfig from '@app/router/routerPathsConfig/routerUpgradePathsConfig.ts';
import routerPlaybooksPathsConfig from '@app/router/routerPathsConfig/routerPlaybooksPathsConfig.ts';
import routerBackupsPathsConfig from '@app/router/routerPathsConfig/routerBackupsPathsConfig.ts';

/*
  Combines route paths into one config
 */
const RouterPaths = {
  login: {
    absolutePath: 'login',
  },
  notFound: {
    absolutePath: 'notFound',
  },
  home: routerHomePathsConfig,
  clusters: routerClustersPathsConfig,
  operations: routerOperationsPathsConfig,
  settings: routerSettingsPathsConfig,
  sqlEditor: routerSqlEditorPathsConfig,
  observability: routerObservabilityPathsConfig,
  audit: routerAuditPathsConfig,
  logs: routerLogsPathsConfig,
  insights: routerInsightsPathsConfig,
  discover: routerDiscoverPathsConfig,
  upgrade: routerUpgradePathsConfig,
  playbooks: routerPlaybooksPathsConfig,
  backups: routerBackupsPathsConfig,
} as const;

export default RouterPaths;
