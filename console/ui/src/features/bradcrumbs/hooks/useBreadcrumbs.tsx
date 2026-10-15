import { useMatches } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

type Crumb = {
  label: string | ((params: Record<string, string | undefined>) => string);
  ns?: string;
  path?: string;
};

const crumbOf = (handle: unknown): Crumb | undefined => (handle as { breadcrumb?: Crumb } | undefined)?.breadcrumb;

const useBreadcrumbs = (): { label: string; path: string }[] => {
  const { t } = useTranslation();
  const matches = useMatches();

  return matches
    .filter((match) => Boolean(crumbOf(match?.handle)))
    .map((match) => {
      const crumb = crumbOf(match.handle) as Crumb;
      return {
        label: typeof crumb.label === 'function' ? crumb.label({ ...match.params }) : t(crumb.label, { ns: crumb.ns }),
        path: crumb.path ?? match.pathname,
      };
    });
};

export default useBreadcrumbs;
