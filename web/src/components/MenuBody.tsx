import type { KeyboardEvent } from 'react';
import type { Advice, Menu, MenuAnswer, Session } from '../types.ts';
import styles from './MenuBody.module.css';
import parts from './Parts.module.css';
import { AdviceBand } from './SecondOpinion.tsx';

const samePicks = (a: readonly MenuAnswer[], b: readonly MenuAnswer[]) =>
  a.length === b.length && a.every((p, i) => !p.other.trim() && !(b[i].other ?? '').trim() && p.labels.length === b[i].labels.length && p.labels.every((l) => b[i].labels.includes(l)));

interface MenuBodyProps {
  session: Session;
  menu: Menu;
  picks: readonly MenuAnswer[];
  advice: Advice | null;
  onPick: (question: number, label: string) => void;
  onOther: (question: number, text: string) => void;
  onPicks: (picks: MenuAnswer[]) => void;
  // Enter in an own answer sends the menu once every question has an answer.
  onSubmit: () => void;
}

// Claude's AskUserQuestion menu: its questions side by side, options numbered across them so 1–9 reach each, and the
// second opinion's band below.
export function MenuBody({ session, menu, picks, advice, onPick, onOther, onPicks, onSubmit }: MenuBodyProps) {
  const done = advice?.state === 'done' && advice.answers?.length === menu.questions.length ? advice : null;
  const suggested = (question: number, label: string) => !!done?.answers![question]?.labels.includes(label);
  const onOtherKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
    e.preventDefault();
    onSubmit();
  };
  let n = 0;
  return (
    <>
      <div className={styles.questions}>
        {menu.questions.map((q, i) => (
          <section key={i} className={styles.question} role="group" aria-label={`${q.header}${q.multiSelect ? ', pick any' : ''}`}>
            <div className={styles.header}>
              <span className={parts.label}>{q.header}</span>
              {q.multiSelect && <span className={styles.any}>pick any</span>}
            </div>
            <h2>{q.question}</h2>
            {q.options.map((o) => {
              n++;
              return (
                <button
                  key={o.label}
                  type="button"
                  className={styles.option}
                  data-option={n}
                  data-multi={q.multiSelect || undefined}
                  aria-pressed={picks[i]?.labels.includes(o.label) ?? false}
                  onClick={() => onPick(i, o.label)}
                >
                  <span className={styles.badge}>{n}</span>
                  <span className={styles.text}>
                    <span className={styles.label}>{o.label}</span>
                    {o.description && <span className={styles.description}>{o.description}</span>}
                  </span>
                  {suggested(i, o.label) && <span className={`${parts.tag} ${styles.tag}`}>Second opinion</span>}
                </button>
              );
            })}
            {!q.multiSelect && (
              <input
                className={styles.other}
                placeholder="Or write your own answer…"
                aria-label={`Your own answer: ${q.header}`}
                value={picks[i]?.other ?? ''}
                onChange={(e) => onOther(i, e.currentTarget.value)}
                onKeyDown={onOtherKey}
              />
            )}
          </section>
        ))}
      </div>
      <AdviceBand
        session={session}
        advice={advice}
        changed={!!done && !samePicks(picks, done.answers!)}
        onUse={() => done && onPicks(done.answers!.map((a) => ({ labels: [...a.labels], other: a.other ?? '' })))}
      />
    </>
  );
}
