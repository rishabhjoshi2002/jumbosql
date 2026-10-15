import { generatePath, resolvePath } from 'react-router-dom';
import { toast } from 'react-toastify';
import { apiErrorText } from '@shared/lib/apiError.ts';
import { format } from 'date-fns/format';
import { isValid } from 'date-fns/isValid';

declare const window: Window & { _env_?: Record<string, string | undefined> };

/**
 * Function generates absolute path that can be used for react-router "navigate" function.
 * @param path - Absolute URN path.
 * @param params - Additional params that will be substituted in URN dynamic values.
 */
export const generateAbsoluteRouterPath = (path: string, params?: Record<string, string | number | null | undefined>) =>
  resolvePath(
    generatePath(
      path,
      params &&
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === null || v === undefined ? v : String(v)])),
    ),
  );

/**
 * Function returns env variable passed to container or variable from .env* files.
 * @param variableName - Name of a variable.
 */
export const getEnvVariable = (variableName: string) => window?._env_?.[variableName] ?? import.meta.env[variableName];

/**
 * Function manages error event when performing request.
 * @param e - Error event.
 */
export const handleRequestErrorCatch = (e: unknown) => {
  console.error(e);
  toast.error(apiErrorText(e));
};

/**
 * Function converts timestamp to easily readable string.
 * @param timestamp - Timestamp to be converted.
 */
export const convertTimestampToReadableTime = (timestamp?: string) =>
  isValid(new Date(timestamp)) ? format(timestamp, 'MMM dd, yyyy, HH:mm:ss') : '-';

export const manageSortingOrder = (
  sorting: {
    desc?: boolean;
    id?: string;
  }[],
) => (sorting?.desc ? `-${sorting?.id}` : sorting?.id);
