import RouterPaths from '@app/router/routerPathsConfig';
import { getSessionUser, isAdmin } from '@shared/lib/session.ts';

const allSettingsTabs = [
  {
    translateKey: 'generalSettings',
    path: RouterPaths.settings.general.absolutePath,
  },
  {
    translateKey: 'secrets',
    path: RouterPaths.settings.secrets.absolutePath,
  },
  {
    translateKey: 'projects',
    path: RouterPaths.settings.projects.absolutePath,
  },
  {
    translateKey: 'environments',
    path: RouterPaths.settings.environments.absolutePath,
  },
  {
    translateKey: 'users',
    path: RouterPaths.settings.users.absolutePath,
    adminOnly: true,
  },
];

// JumboSQL: the Users tab is shown to admins only (the API enforces it as well)
export const getSettingsTabs = () => allSettingsTabs.filter((tab) => !tab.adminOnly || isAdmin(getSessionUser()));
