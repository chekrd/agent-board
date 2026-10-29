import { useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '../types.ts';
import { Age } from './Parts.tsx';
import parts from './Parts.module.css';
import styles from './TaskRail.module.css';

// What the task is for and where it stands, beside every card, so a decision can be made without its Overview. A
// Your-turn card's headline is the summary already, so its rail leaves the summary's text out.
export function TaskRail({ session, summaryText = true }: { session: Session; summaryText?: boolean }) {
  const { summary, parent } = session;
  const goal = parent ? `Finding #${parent.finding + 1}: ${parent.title}` : session.firstPrompt;
  const progress = summary?.progress ?? [];
  const text = summaryText ? summary?.text : null;
  return (
    <aside className={styles.rail} aria-label="The task" data-rail>
      {goal && (
        <section>
          <h3 className={parts.label}>Task</h3>
          <Goal key={goal} text={goal} />
        </section>
      )}
      {(text || progress.length > 0) && (
        <section>
          <h3 className={parts.label} title="A short summary of the session, rewritten by a model after each of Claude's messages">
            Session summary {summary && <span className={styles.age}>· <Age at={summary.at} /></span>}
          </h3>
          {text && <p>{text}</p>}
          {progress.length > 0 && <ul>{progress.map((p) => <li key={p}>{p}</li>)}</ul>}
        </section>
      )}
    </aside>
  );
}

function Goal({ text }: { text: string }) {
  const body = useRef<HTMLParagraphElement>(null);
  const [folded, setFolded] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    setFolded(el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <>
      <p ref={body} className={styles.goal} data-full={full || undefined} data-goal>{text}</p>
      {folded && <button type="button" className={parts.tiny} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </>
  );
}
