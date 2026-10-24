import { useActionState, useState } from 'react';
import { sessionAction } from '../api.ts';
import type { Menu } from '../types.ts';
import { ago } from '../util.ts';
import detail from './Detail.module.css';
import styles from './MenuCard.module.css';

export interface MenuAnswer {
  labels: string[];
  other: string;
}

export function MenuCard({ sessionId, menu }: { sessionId: string; menu: Menu }) {
  const [answers, setAnswers] = useState<MenuAnswer[]>(() => menu.questions.map(() => ({ labels: [], other: '' })));
  const [error, submit, pending] = useActionState(async () => {
    try {
      await sessionAction(sessionId, 'answer-menu', { toolUseId: menu.toolUseId, answers });
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);
  const set = (i: number, next: Partial<MenuAnswer>) => setAnswers(answers.map((a, j) => (j === i ? { ...a, ...next } : a)));
  const complete = answers.every((a) => a.labels.length || a.other.trim());

  return (
    <form className={detail.decision} action={submit}>
      <div className={detail.decisionMeta}>
        <strong title="Claude asked you this and waits for the answer">Decision</strong>
        <span title="Claude opened a choice menu in its terminal; answering here picks the options there for you">asked in the terminal</span>
        <span className={detail.age}>asked {ago(menu.at)}</span>
      </div>
      {menu.questions.map((q, i) => {
        const a = answers[i];
        const toggle = (label: string) =>
          set(i, q.multiSelect
            ? { labels: a.labels.includes(label) ? a.labels.filter((l) => l !== label) : [...a.labels, label] }
            : { labels: a.labels[0] === label ? [] : [label], other: '' });
        return (
          <fieldset key={q.question} className={styles.question} disabled={pending}>
            <legend>{q.header}{q.multiSelect && <span> · pick any</span>}</legend>
            <h3>{q.question}</h3>
            <div className={styles.options}>
              {q.options.map((o) => (
                <button key={o.label} type="button" aria-pressed={a.labels.includes(o.label)} title={o.description} onClick={() => toggle(o.label)}>
                  {o.label}
                  {o.description && <small>{o.description}</small>}
                </button>
              ))}
            </div>
            {!q.multiSelect && (
              <input
                placeholder="Or write your own answer…"
               
                value={a.other}
                onChange={(e) => set(i, { other: e.currentTarget.value, ...(e.currentTarget.value && { labels: [] }) })}
              />
            )}
          </fieldset>
        );
      })}
      <div className={styles.submit}>
        <button type="submit" data-variant="primary" disabled={pending || !complete} title="Picks your answers in Claude's terminal menu">Send answer</button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}
