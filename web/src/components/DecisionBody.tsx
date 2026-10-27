import type { Ref } from 'react';
import type { Frozen } from '../deck.ts';
import type { Request } from '../outbox.ts';
import type { Advice, Session } from '../types.ts';
import type { DecisionView } from '../util.ts';
import styles from './Card.module.css';
import { Composer } from './Composer.tsx';
import { Markdown } from './Markdown.tsx';
import { Options } from './Options.tsx';
import parts from './Parts.module.css';
import { Column, Headline } from './Parts.tsx';
import { SecondOpinion } from './SecondOpinion.tsx';
import { WhyPanel } from './WhyPanel.tsx';

export interface ComposerHooks {
  focus: number;
  note: string | null;
  onSend: (request: Request) => void;
  onEscape: () => void;
}

interface DecisionBodyProps {
  session: Session;
  decision: DecisionView;
  kind: 'ask' | 'turn';
  advice: Advice | null;
  frozen: Frozen | null;
  accepting: boolean;
  hidden: boolean;
  onDetails: () => void;
  whyOpen: boolean;
  whyRef: Ref<HTMLElement>;
  onCloseWhy: () => void;
  onPick: (label: string) => void;
  onAccept: () => void;
  onEdit: () => void;
  // The reply box while it is open.
  composer: ComposerHooks | null;
}

// An ask_human question or an end-of-turn choice: the problem and Claude's details on the left, the second opinion,
// the options and the reply box on the right. An end-of-turn choice shows Claude's whole last message as its context.
export function DecisionBody(p: DecisionBodyProps) {
  const { session, decision } = p;
  const done = p.advice?.state === 'done' ? p.advice : null;
  const title = p.kind === 'ask' ? "Claude's details" : 'Context';
  return (
    <div className={styles.cols}>
      <Column side="left">
        <Headline text={decision.problem} />
        {decision.brief && (p.kind === 'ask'
          ? <p className={styles.lead}>{decision.brief}</p>
          : <p className={`${styles.lead} ${styles.oneLine}`} title={decision.brief}>{decision.brief}</p>)}
        {decision.context && (
          <section className={styles.details} aria-label={title}>
            <div className={styles.detailsHead}>
              <h3 className={parts.label}>{title}</h3>
              <button type="button" className={parts.tiny} aria-expanded={!p.hidden} onClick={p.onDetails}>
                {p.hidden ? 'Show' : 'Hide'} <kbd>Space</kbd>
              </button>
            </div>
            {!p.hidden && <div className={parts.body}><Markdown source={decision.context} /></div>}
          </section>
        )}
        {p.whyOpen && <WhyPanel ref={p.whyRef} session={session} decision={decision.key} onClose={p.onCloseWhy} />}
      </Column>
      <Column side="right">
        <SecondOpinion session={session} advice={p.advice} />
        <Options
          options={decision.options}
          advice={done}
          frozen={p.frozen}
          composing={!!p.composer}
          accepting={p.accepting}
          onPick={p.onPick}
          onAccept={p.onAccept}
          onEdit={p.onEdit}
        />
        {p.composer && (
          <Composer
            session={session}
            decision={decision.key}
            label="Your own answer"
            placeholder={decision.options.length ? 'Or write your own answer, / for commands, paste or drop files…' : 'Reply, / for commands, paste or drop files…'}
            {...p.composer}
          />
        )}
      </Column>
    </div>
  );
}
