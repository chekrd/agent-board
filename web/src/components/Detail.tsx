import { useState } from 'react';
import { sessionAction } from '../api.ts';
import type { Session } from '../types.ts';
import { ago, type DecisionView } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import styles from './Detail.module.css';
import { Markdown } from './Markdown.tsx';

export function DecisionCard({ session, decision }: { session: Session; decision: DecisionView }) {
  const q = session.question;
  const [open, setOpen] = useState(false);
  const explanation = session.explanation?.key === decision.key ? session.explanation : null;
  const request = () => sessionAction(session.id, 'elaborate', { key: decision.key }).catch(reportError);
  const toggle = () => {
    if (!open && (!explanation || explanation.state === 'failed')) void request();
    setOpen(!open);
  };

  return (
    <section className={styles.decision}>
      <div className={styles.decisionMeta}>
        <strong title={q ? 'Claude asked you this and waits for the answer' : 'Claude ended its turn with a choice for you; a model read it from its last message'}>Decision</strong>
        {q && <span title="The kind of question, as Claude classified it">{q.category}</span>}
        {session.rankReason && <em>{session.rankReason}</em>}
        {q && <span className={styles.age}>asked {ago(q.askedAt)}</span>}
      </div>
      <h3>{decision.problem}</h3>
      {decision.brief && <p className={styles.brief}>{decision.brief}</p>}
      {decision.context && <div className={styles.context}><Markdown source={decision.context} /></div>}
      <button type="button" className={styles.elaborate} data-variant="ghost" aria-expanded={open} onClick={toggle} title={open ? undefined : 'A model reads the code and explains the background and each choice'}>
        {open ? 'Less' : 'Elaborate'}
      </button>
      {open && (
        <div className={styles.elaboration}>
          {!explanation || explanation.state === 'thinking' ? (
            <p className={styles.thinking}><span className={styles.spinner} aria-hidden /> Reading the code to explain this…</p>
          ) : explanation.state === 'failed' ? (
            <p className={styles.failed}>
              Could not explain: {explanation.error} <button type="button" data-variant="ghost" onClick={request}>Retry</button>
            </p>
          ) : (
            <Markdown source={explanation.text} />
          )}
        </div>
      )}
      <AnswerForm session={session} decision={decision} />
    </section>
  );
}
