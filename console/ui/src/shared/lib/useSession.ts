import { useSyncExternalStore } from 'react';
import { getSessionUser, subscribeSession } from '@shared/lib/session.ts';

/** The signed-in user; re-renders when the session or its permissions change. */
export const useSessionUser = () => useSyncExternalStore(subscribeSession, getSessionUser, getSessionUser);
