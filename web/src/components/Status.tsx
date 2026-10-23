import type { Session, SessionStatus } from '../types.ts';
import styles from './Status.module.css';

const labels: Record<SessionStatus, string> = {
  working: 'working',
  idle: 'your turn',
  waiting: 'waiting for you',
  exited: 'ended',
};

export function StatusChip({ session }: { session: Session }) {
  const label = session.status === 'waiting' && session.waitingFor ? session.waitingFor : labels[session.status];
  return <span className={styles.chip} data-status={session.status}>{label}</span>;
}

export function DiffStat({ stat }: { stat: Session['diffstat'] }) {
  if (!stat) return null;
  return (
    <span className={styles.stat} title={`${stat.files} files changed`}>
      <span className={styles.add}>+{stat.insertions}</span> <span className={styles.del}>−{stat.deletions}</span>
    </span>
  );
}
