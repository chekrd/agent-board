import type { PrFlow, Session, SessionStatus } from '../types.ts';
import type { Shown } from '../util.ts';
import styles from './Status.module.css';

export const STATE_LABELS: Record<Shown, string> = {
  sending: 'Sending',
  decide: 'Decide',
  focus: 'Needs focus',
  working: 'In progress',
  idle: 'Your turn',
  exited: 'Ended',
};

export const STATE_HINTS: Record<Shown, string> = {
  sending: 'Your answer goes out in a few seconds; Undo takes it back',
  decide: 'Claude asked you something and waits for your decision',
  focus: 'Claude is showing a prompt in its terminal that only the terminal can answer',
  working: 'Claude is working on its turn; nothing for you to do yet',
  idle: 'Claude finished its turn and waits for your next message',
  exited: 'The Claude process has quit; Continue resumes the conversation',
};

// A turn that ended on an API error waits for you like any other, but no reply came.
export const stoppedOnError = (s: Session, shown: Shown) => shown === 'idle' && !!s.turnError && !s.archived;

export const labelOf = (s: Session, shown: Shown) => (stoppedOnError(s, shown) ? 'Stopped on an error' : STATE_LABELS[shown]);

export const ERROR_LINES = {
  refusal: "The model's safeguards flagged your last message; rephrase it",
  limit: 'The usage limit stopped the turn; send again once it resets',
  login: 'The login expired; run /login in its terminal',
  other: 'The request failed; send your message again',
} as const;

export const hintOf = (s: Session, shown: Shown) =>
  stoppedOnError(s, shown) ? "Claude's turn ended on an API error instead of a reply; the task's page says what to do" : STATE_HINTS[shown];

const prLabels: Record<string, string> = {
  RUNNING: 'checks running',
  PASSED: 'green',
  FAILED: 'failed',
  CLOSED: 'closed',
  ERROR: 'az error',
};

function prState(pr: PrFlow, status: SessionStatus) {
  const result = pr.result?.split(' ')[0];
  const fixing = result === 'FAILED' && !pr.watching && status === 'working';
  const closedAs = result === 'CLOSED' && (pr.result!.endsWith('completed') ? 'merged' : pr.result!.split(' ').at(-1));
  const label = !pr.id ? 'opening PR' : fixing ? 'fixing' : closedAs || (result ? prLabels[result] : 'checks pending');
  return { result, label, state: !pr.id ? 'RUNNING' : result ?? 'RUNNING' };
}

export function PrChip({ pr, status }: { pr: PrFlow; status: SessionStatus }) {
  const { result, label, state } = prState(pr, status);
  const failed = result === 'FAILED' ? pr.result!.split(': ').slice(1).join(': ') : '';
  const title = [
    'Pull request and the state of its checks',
    pr.result ?? 'No result yet',
    failed && `Failed: ${failed}`,
    pr.watching ? 'pr-to-green is watching the checks' : 'Not watching right now',
  ].filter(Boolean).join('\n');
  const text = <>{pr.repo && `${pr.repo} `}PR{pr.id ? ` ${pr.id}` : ''} · {label}</>;
  const marks = { className: styles.pr, 'data-state': state, 'data-label': label, 'data-watching': pr.watching || undefined, title };
  return pr.url ? <a {...marks} href={pr.url} target="_blank" rel="noreferrer">{text}</a> : <span {...marks}>{text}</span>;
}

export function PrDot({ pr, status }: { pr: PrFlow; status: SessionStatus }) {
  const { label, state } = prState(pr, status);
  return <span className={styles.dot} data-pr data-state={state} data-label={label} data-watching={pr.watching || undefined} aria-hidden />;
}

export const prKey = (pr: PrFlow) => `${pr.repo ?? ''}#${pr.id ?? 'opening'}`;

export const PrChips = ({ prs, status }: { prs: PrFlow[]; status: SessionStatus }) =>
  prs.map((pr) => <PrChip key={prKey(pr)} pr={pr} status={status} />);

export const PrDots = ({ prs, status }: { prs: PrFlow[]; status: SessionStatus }) =>
  prs.map((pr) => <PrDot key={prKey(pr)} pr={pr} status={status} />);
