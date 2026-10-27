'use client';

import { useSyncExternalStore } from 'react';

import {
  listInAppNotifications,
  subscribeInApp,
  type InAppNotification,
} from '@/lib/in-app-notifications';

const EMPTY: InAppNotification[] = [];

const getEmpty = () => EMPTY;

/**
 * Subscribes to the client-side aggregated notification feed (chat + call
 * mirrors that the dashboard bell merges with the server task feed). Uses
 * `useSyncExternalStore` so SSR returns an empty list and the client takes
 * over on hydration without a tearing flicker.
 */
export function useInAppNotifications(): InAppNotification[] {
  return useSyncExternalStore(
    subscribeInApp,
    listInAppNotifications,
    getEmpty,
  );
}
