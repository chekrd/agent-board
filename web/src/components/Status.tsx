import type { PrFlow, Session, SessionStatus } from '../types.ts';
import { attentionOf, type Attention } from '../util.ts';
import styles from './Status.module.css';

const labels: Record<Attention, string> = {
  decide: 'Decide',
  focus: 'Needs focus',
  working: 'In progress',
  idle: 'Your turn',
  exited: 'Ended',
};

const hints: Record<Attention, string> = {
  decide: 'Claude asked you something and waits for your decision',
  focus: 'Claude is showing a prompt in its terminal that only the terminal can answer',
  working: 'Claude is working on its turn; nothing for you to do yet',
  idle: 'Claude finished its turn and waits for your next message',
  exited: 'The Claude process has quit; Continue resumes the conversation',
};

export function AttentionChip({ session }: { session: Session }) {
  const attention = attentionOf(session);
  return (
    <span className={styles.chip} data-attention={attention} title={attention === 'focus' ? `Claude is showing ${session.waitingFor ?? 'a prompt'} in its terminal; answer it there` : hints[attention]}>
      {labels[attention]}
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
    'Pull request and the state of its checks',
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
