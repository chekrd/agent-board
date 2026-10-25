import type { Session } from '../types.ts';
import { Elapsed } from './Elapsed.tsx';
import styles from './Working.module.css';

export function Working({ session, large = false }: { session: Session; large?: boolean }) {
  const a = session.activity;
  if (session.status !== 'working') return null;
  return (
    <div className={styles.working} data-large={large || undefined}>
      <span className={styles.spinner} aria-hidden />
      {large && <strong>Claude is working</strong>}
      <span className={styles.step} title={a?.step ?? undefined}>{a?.step ?? 'Starting'}</span>
      {a && <span className={styles.elapsed} title="Time since your last message"><Elapsed since={a.since} /></span>}
    </div>
  );
}
