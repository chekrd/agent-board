import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { showTab } from '../router.ts';
import type { ConversationLog, Session } from '../types.ts';
import { ago, clock } from '../util.ts';
import styles from './Conversation.module.css';
import { Markdown } from './Markdown.tsx';

// Read only while open: the whole transcript can run to many megabytes. A new reply or a /clear reads it again. It opens
// on your last prompt, so its reply reads with the question in view.
export function Conversation({ session }: { session: Session }) {
  const [log, setLog] = useState<ConversationLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const read = useRef(false);

  useEffect(() => {
    let live = true;
    api<ConversationLog[]>('GET', `/api/sessions/${session.id}/conversation`).then(
      (l) => live && (setLog(l), setError(null)),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [session.id, session.conversation, session.lastMessage]);

  useLayoutEffect(() => {
    if (!log || read.current) return;
    read.current = true;
    [...box.current?.querySelectorAll('[data-prompt]') ?? []].at(-1)?.scrollIntoView({ block: 'start' });
  }, [log]);

  if (!log) return <div className={styles.scroll}><p className={styles.note}>{error ?? 'Reading the conversation…'}</p></div>;
  const empty = log.every((c) => !c.exchanges.length);
  const artifacts = new Map(session.artifacts.map((a) => [a.id, a]));
  return (
    <div className={styles.scroll}>
      <div ref={box} className={styles.log}>
        {error && <p className={styles.note}>{error}</p>}
        {empty && <p className={styles.note}>No prompts yet.</p>}
        {log.map((c, i) => (
          <section key={c.id} className={styles.conversation} data-conversation={c.id}>
            {i > 0 && <p className={styles.cleared}>/clear · a new conversation</p>}
            {c.exchanges.map((e) => (
              <article key={e.id} className={styles.exchange}>
                <div className={styles.prompt} data-prompt>
                  <h3>You <time title={ago(e.at)}>{clock(e.at, true)}</time></h3>
                  {e.prompt && <p>{e.prompt}</p>}
                  {e.images > 0 && (
                    <div className={styles.images}>
                      {Array.from({ length: e.images }, (_, n) => {
                        const src = `/api/sessions/${session.id}/conversation/${c.id}/${e.id}/${n}`;
                        return (
                          <button key={src} type="button" aria-pressed={zoomed === src} title={zoomed === src ? 'Smaller' : 'Larger'} onClick={() => setZoomed(zoomed === src ? null : src)}>
                            <img src={src} alt={`Image #${n + 1}`} loading="lazy" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
                {e.reply ? (
                  <div className={styles.reply} data-reply>
                    <h3>Claude</h3>
                    <Markdown source={e.reply} />
                  </div>
                ) : <p className={styles.none} data-reply>No reply from Claude: still working, or stopped.</p>}
                {e.artifacts.some((id) => artifacts.has(id)) && (
                  <div className={styles.artifacts}>
                    {e.artifacts.filter((id) => artifacts.has(id)).map((id) => (
                      <button key={id} type="button" onClick={() => showTab('artifacts', id)}>
                        <span>Artifact</span>
                        <strong>{artifacts.get(id)!.title}</strong>
                      </button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
