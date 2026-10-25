import { useState } from 'react';
import { sessionAction } from '../api.ts';
import type { Advice, Session } from '../types.ts';
import { Clock } from './Clock.tsx';
import parts from './Parts.module.css';
import styles from './SecondOpinion.module.css';

export const level = (confidence: number) => (confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low');

// Stop and Retry act at once: they change only the second opinion, never what Claude is told.
function useAdviceAction(session: Session, advice: Advice) {
  const [pending, setPending] = useState(false);
  const act = async (action: 'stop-advice' | 'retry-advice') => {
    setPending(true);
    try {
      await sessionAction(session.id, action, { key: advice.key });
    } catch (err) {
      reportError(err);
    } finally {
      setPending(false);
    }
  };
  return { pending, act };
}

function Running({ session, advice, className }: { session: Session; advice: Advice; className: string }) {
  const { pending, act } = useAdviceAction(session, advice);
  return (
    <div className={className} data-advice="running">
      <div className={styles.row}>
        <span className={parts.spinner} aria-hidden />
        <strong title="Another model reads the code and suggests what you would likely answer">Second opinion in progress</strong>
        <span className={styles.clock}><Clock since={advice.startedAt} /></span>
        <button type="button" className={parts.tiny} disabled={pending} onClick={() => act('stop-advice')}>Stop</button>
      </div>
      <code className={styles.step}>{advice.activity ?? 'Working'}</code>
    </div>
  );
}

function Failed({ session, advice, className }: { session: Session; advice: Advice; className: string }) {
  const { pending, act } = useAdviceAction(session, advice);
  return (
    <div className={className} data-advice="failed">
      <span className={styles.failed} title={advice.error}>{advice.error === 'stopped' ? 'Second opinion stopped' : `Second opinion failed: ${advice.error}`}</span>
      <button type="button" className={parts.tiny} disabled={pending} onClick={() => act('retry-advice')}>Retry</button>
    </div>
  );
}

// Above a decision's options: running or failed. A finished one shows on its option instead.
export function SecondOpinion({ session, advice }: { session: Session; advice: Advice | null }) {
  if (advice?.state === 'thinking') return <Running session={session} advice={advice} className={styles.box} />;
  if (advice?.state === 'failed') return <Failed session={session} advice={advice} className={styles.box} />;
  return null;
}

// Under a menu's questions: the second opinion in every state, and the way back to its picks once they differ.
export function AdviceBand({ session, advice, changed, onUse }: { session: Session; advice: Advice | null; changed: boolean; onUse: () => void }) {
  if (advice?.state === 'thinking') return <Running session={session} advice={advice} className={styles.band} />;
  if (advice?.state === 'failed') return <Failed session={session} advice={advice} className={styles.band} />;
  const done = advice?.state === 'done' ? advice : null;
  return (
    <div className={styles.band} data-advice={done ? 'done' : 'none'}>
      <div className={styles.row}>
        <span className={parts.tag} title="Another model's suggestion of what you would likely answer; it goes out 5 s after you send, and Z takes it back">
          {done ? `Second opinion · ${done.confidence}% · ${level(done.confidence)}` : 'Second opinion'}
        </span>
        <span className={styles.reasoning}>{done?.reasoning || 'No second opinion yet.'}</span>
        {done && changed && <button type="button" className={parts.tiny} onClick={onUse}>Use the suggestion</button>}
      </div>
    </div>
  );
}
