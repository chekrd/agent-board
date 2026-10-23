import type { PrFlow, Session, SessionStatus } from '../types.ts';
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

const prLabels: Record<string, string> = {
  RUNNING: 'checks running',
  PASSED: 'green',
  FAILED: 'failed',
  CLOSED: 'closed',
  ERROR: 'az error',
};

export function PrChip({ pr, status }: { pr: PrFlow | null; status: SessionStatus }) {
  if (!pr) return null;
  const result = pr.result?.split(' ')[0];
  const failed = result === 'FAILED' ? pr.result!.split(': ').slice(1).join(': ') : '';
  const fixing = result === 'FAILED' && !pr.watching && status === 'working';
  const closedAs = result === 'CLOSED' && (pr.result!.endsWith('completed') ? 'merged' : pr.result!.split(' ').at(-1));
  const label = !pr.id ? 'opening PR' : fixing ? 'fixing' : closedAs || (result ? prLabels[result] : 'checks pending');
  const state = !pr.id ? 'RUNNING' : result ?? 'RUNNING';
  const title = [
    pr.result ?? 'No result yet',
    failed && `Failed: ${failed}`,
    pr.watching ? 'pr-to-green is watching the checks' : 'Not watching right now',
  ].filter(Boolean).join('\n');
  const text = <>PR{pr.id ? ` ${pr.id}` : ''} · {label}</>;
  return pr.url ? (
    <a className={styles.pr} data-state={state} data-watching={pr.watching || undefined} href={pr.url} target="_blank" rel="noreferrer" title={title}>{text}</a>
  ) : (
    <span className={styles.pr} data-state={state} data-watching={pr.watching || undefined} title={title}>{text}</span>
  );
}
