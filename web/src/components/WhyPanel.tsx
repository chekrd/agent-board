import type { Ref } from 'react';
import { sessionAction } from '../api.ts';
import type { Session } from '../types.ts';
import { Markdown } from './Markdown.tsx';
import parts from './Parts.module.css';
import styles from './WhyPanel.module.css';

export const explanationFor = (s: Session, key: string) => (s.explanation?.key === key ? s.explanation : null);

export const elaborate = (s: Session, key: string) => void sessionAction(s.id, 'elaborate', { key }).catch(reportError);

// Elaborate: the background of the decision, which a model reads from the code. It opens below Claude's details,
// never in their place.
export function WhyPanel({ session, decision, onClose, ref }: { session: Session; decision: string; onClose: () => void; ref: Ref<HTMLElement> }) {
  const e = explanationFor(session, decision);
  return (
    <section ref={ref} className={styles.why} aria-label="Elaborate: the background, read from the code" data-elaborate={e?.state ?? 'thinking'}>
      <div className={styles.head}>
        <h3 className={parts.label}>Elaborate · read from the code</h3>
        <button type="button" className={parts.tiny} onClick={onClose}>Close <kbd>Y</kbd></button>
      </div>
      {!e || e.state === 'thinking' ? (
        <p className={styles.loading}><span className={parts.spinner} aria-hidden />Reading the code to explain this…</p>
      ) : e.state === 'failed' ? (
        <p className={styles.failed}>
          <span>Could not explain: {e.error}</span>
          <button type="button" className={parts.tiny} onClick={() => elaborate(session, decision)}>Retry</button>
        </p>
      ) : (
        <div className={styles.text}><Markdown source={e.text} /></div>
      )}
    </section>
  );
}
