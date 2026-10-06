import RouterPaths from '@app/router/routerPathsConfig';
import { canAny } from '@shared/lib/session.ts';

const allSettingsTabs = [
  {
    translateKey: 'generalSettings',
    path: RouterPaths.settings.general.absolutePath,
    perms: ['settings.manage'],
  },
  {
    translateKey: 'secrets',
    path: RouterPaths.settings.secrets.absolutePath,
    perms: ['settings.manage', 'clusters.manage'],
  },
  {
    translateKey: 'projects',
    path: RouterPaths.settings.projects.absolutePath,
    perms: ['settings.manage'],
  },
  {
    translateKey: 'environments',
    path: RouterPaths.settings.environments.absolutePath,
    perms: ['settings.manage'],
  },
  {
    translateKey: 'users',
    path: RouterPaths.settings.users.absolutePath,
    perms: ['users.manage'],
  },
  {
    translateKey: 'accessPolicies',
    path: RouterPaths.settings.policies.absolutePath,
    perms: ['policies.manage'],
  },
];

// JumboSQL: tabs follow the access policies (the API enforces them as well)
export const getSettingsTabs = () => allSettingsTabs.filter((tab) => canAny(tab.perms));
