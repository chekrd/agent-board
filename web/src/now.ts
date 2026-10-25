import { useSyncExternalStore } from 'react';

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribers = new Set<() => void>();

export function subscribe(fn: () => void) {
  subscribers.add(fn);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const s of subscribers) s();
    }, 1000);
  }
  return () => {
    subscribers.delete(fn);
    if (subscribers.size) return;
    clearInterval(timer);
    timer = undefined;
  };
}

// No ticker refreshes `now` while no clock is mounted, so the next one to mount would show the time the last one
// stopped at. Refreshing it only once it is a second old keeps repeated reads within one render equal.
export function snapshot() {
  if (!timer && Date.now() - now >= 1000) now = Date.now();
  return now;
}

export const useNow = () => useSyncExternalStore(subscribe, snapshot);

export function clock(since: number, at: number) {
  const seconds = Math.max(0, Math.floor((at - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  const mmss = `${minutes % 60}:${String(seconds % 60).padStart(2, '0')}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${mmss.padStart(5, '0')}` : mmss;
}
