import type { Session, SessionStatus } from '../types.ts';
import styles from './Status.module.css';

const labels: Record<SessionStatus, string> = {
  working: 'working',
  idle: 'idle',
  permission: 'waiting for permission',
  exited: 'exited',
};

export function StatusChip({ status }: { status: SessionStatus }) {
  return <span className={styles.chip} data-status={status}>{labels[status]}</span>;
}

export function DiffStat({ stat }: { stat: Session['diffstat'] }) {
  if (!stat) return null;
  return (
    <span className={styles.stat} title={`${stat.files} files changed`}>
      <span className={styles.add}>+{stat.insertions}</span> <span className={styles.del}>−{stat.deletions}</span>
    </span>
  );
}
