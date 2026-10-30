import { useStore } from '../store.ts';
import styles from './RestartBanner.module.css';

// Claude Code changed a file Pitwall reads without a documented format, so tasks may show stale or wrong states.
export function DriftBanner() {
  const { drift } = useStore();
  if (!drift.length) return null;
  const versions = [...new Set(drift.flatMap((d) => (d.version ? [d.version] : [])))];
  return (
    <section className={styles.banner} data-drift aria-live="polite">
      <p>
        <strong>Claude Code{versions.length ? ` ${versions.join(', ')}` : ''} changed what Pitwall reads</strong>: {drift.map((d) => d.problem).join('; ')}.
        {' '}Tasks may show a stale state until Pitwall is updated for it.
      </p>
    </section>
  );
}
