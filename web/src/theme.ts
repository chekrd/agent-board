import { useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'agent-board:theme';
const subscribers = new Set<() => void>();

// Kept in this browser only: storage may be off, as in a private window, and then the theme follows the system.
function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

let theme = stored();

// Light and dark fix the page's color-scheme, which every light-dark() colour follows; system leaves it to the OS.
function apply() {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
apply();

export function setTheme(next: Theme) {
  theme = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    // shown for this page only
  }
  apply();
  for (const fn of subscribers) fn();
}

// Another tab of the board changed it.
addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  theme = stored();
  apply();
  for (const fn of subscribers) fn();
});

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

export const useTheme = () => useSyncExternalStore(subscribe, () => theme);
