import { useSyncExternalStore } from 'react';

let now = Date.now();
let timer: ReturnType<typeof setInterval> | undefined;
const subscribers = new Set<() => void>();

function subscribe(fn: () => void) {
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

export const useNow = () => useSyncExternalStore(subscribe, () => now);

export function clock(since: number, at: number) {
  const seconds = Math.max(0, Math.floor((at - since) / 1000));
  const minutes = Math.floor(seconds / 60);
  const mmss = `${minutes % 60}:${String(seconds % 60).padStart(2, '0')}`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${mmss.padStart(5, '0')}` : mmss;
}
