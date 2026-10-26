import { useEffect, useState } from 'react';
import { useStore } from '../store.ts';
import type { Usage as Reading, UsageWindow } from '../types.ts';
import { clock } from '../util.ts';
import styles from './Usage.module.css';

const WINDOWS = [
  { key: 'fiveHour', label: '5h', name: '5-hour limit', weekday: false },
  { key: 'sevenDay', label: '7d', name: 'Weekly limit', weekday: true },
] as const;

// The reset as the top bar shows it: the time alone when it is today, with the weekday otherwise.
function resetLabel(at: number, now: number) {
  return clock(at, new Date(at).toDateString() !== new Date(now).toDateString());
}

const levelOf = (percent: number) => (percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low');

// A window whose reset time has passed starts again from nothing, until the next reading says otherwise. The time is
// taken anew with every reading and once the next reset has passed.
function useNow(usage: Reading | null) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => setNow(Date.now()), [usage]);
  useEffect(() => {
    const next = Math.min(...WINDOWS.map((w) => usage?.[w.key]?.resetsAt ?? Infinity).filter((at) => at > now));
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0) + 1000, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [usage, now]);
  return now;
}

// The plan's 5-hour and weekly usage limits, as Claude Code's status line last read them.
export function Usage() {
  const { usage } = useStore();
  const now = useNow(usage);
  const read = usage ? clock(usage.at) : '';
  return (
    <div className={styles.usage} role="group" aria-label="Plan usage limits" data-usage>
      {WINDOWS.map((w) => {
        const win: UsageWindow | null | undefined = usage?.[w.key];
        if (!win) {
          const title = `${w.name}: no reading yet. Claude Code's status line writes it; see the README.`;
          return (
            <span key={w.key} className={styles.window} data-window={w.label} title={title} aria-label={title}>
              <span className={styles.label}>{w.label}</span>
              <span className={styles.percent}>–</span>
            </span>
          );
        }
        const reset = win.resetsAt !== null && win.resetsAt <= now;
        const percent = reset ? 0 : Math.round(win.percent);
        const at = win.resetsAt && clock(win.resetsAt, w.weekday);
        const title = reset
          ? `${w.name}: reset at ${at}, with no reading since`
          : `${w.name}: ${percent}% used${at ? ` · resets ${at}` : ''} · read at ${read}`;
        return (
          <span key={w.key} className={styles.window} data-window={w.label} data-level={levelOf(percent)} title={title} aria-label={title}>
            <span className={styles.label}>{w.label}</span>
            <span className={styles.track} aria-hidden>
              <span className={styles.fill} style={{ width: `${Math.min(percent, 100)}%` }} />
            </span>
            <span className={styles.percent}>{percent}%</span>
            {!reset && win.resetsAt !== null && <span className={styles.reset} data-reset aria-hidden>↻ {resetLabel(win.resetsAt, now)}</span>}
          </span>
        );
      })}
    </div>
  );
}
