import { useSyncExternalStore } from 'react';
import { api } from './api.ts';

export type ColorScheme = 'light' | 'dark';

const query = matchMedia('(prefers-color-scheme: dark)');

const subscribe = (fn: () => void) => {
  query.addEventListener('change', fn);
  return () => query.removeEventListener('change', fn);
};

export const useColorScheme = (): ColorScheme => useSyncExternalStore(subscribe, () => (query.matches ? 'dark' : 'light'));

export const reportColorScheme = () => api('POST', '/api/appearance', { scheme: query.matches ? 'dark' : 'light' }).catch(() => {});

query.addEventListener('change', reportColorScheme);
