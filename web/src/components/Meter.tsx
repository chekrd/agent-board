import { arrivals, meter } from '../deck.ts';
import { queue, useQueue } from '../queue.ts';
import { go } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { locate, sessionLabel } from '../util.ts';
import styles from './Meter.module.css';
import { STATE_LABELS } from './Status.tsx';

const jump = (id: string) => {
  queue.jump(id);
  go('/');
};

// One segment per waiting card, or a bar per kind past 20. Its counts are in the aria-label and the tab title, not on
// screen; the slot beside it announces cards that arrived since the page loaded.
export function Meter({ deck, repos, current }: { deck: readonly Session[]; repos: RepoView[]; current: string | null }) {
  const { seen, front } = useQueue();
  const arrived = seen ? arrivals(deck, seen, front) : [];
  const { label, segments, bars } = meter(deck, current, new Set(arrived.map((s) => s.id)));
  const nameOf = (s: Session) => sessionLabel(s, locate(repos, s).branch);

  return (
    <div className={styles.meter} data-meter>
      <div className={styles.track} role="group" aria-label={label} data-bars={bars ? '' : undefined}>
        {segments?.map((seg, i) => {
          const s = deck[i];
          const text = `${nameOf(s)} · ${STATE_LABELS[seg.attention]}`;
          return (
            <button
              key={seg.id}
              type="button"
              className={styles.segment}
              data-segment
              data-session={seg.id}
              data-attention={seg.attention}
              data-group-start={(i > 0 && segments[i - 1].attention !== seg.attention) || undefined}
              data-current={seg.current || undefined}
              data-new={seg.arrived || undefined}
              aria-current={seg.current || undefined}
              aria-label={text}
              title={text}
              onClick={() => jump(seg.id)}
            />
          );
        })}
        {bars?.map((bar) => (
          <button
            key={bar.attention}
            type="button"
            className={styles.bar}
            style={{ flexGrow: bar.count }}
            data-bar
            data-attention={bar.attention}
            data-current={bar.current || undefined}
            data-new={bar.arrived || undefined}
            aria-label={`${bar.count} · ${STATE_LABELS[bar.attention]}`}
            title={`${bar.count} · ${STATE_LABELS[bar.attention]}`}
            onClick={() => jump(bar.target)}
          >
            {bar.count}
          </button>
        ))}
      </div>
      {arrived.length > 0 && (
        <span className={styles.slot} role="status">
          <button type="button" className={styles.justin} data-justin onClick={() => jump(arrived[0].id)}>
            <span className={styles.dot} aria-hidden />
            <span className={styles.long}>
              Just in: {nameOf(arrived[0])}
              {arrived.length > 1 && <span className={styles.more}> +{arrived.length - 1}</span>}
            </span>
            <span className={styles.short}>Just in</span>
          </button>
        </span>
      )}
    </div>
  );
}
