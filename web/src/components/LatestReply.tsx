import { useLayoutEffect, useRef, useState } from 'react';
import styles from './LatestReply.module.css';
import { Markdown } from './Markdown.tsx';

export function LatestReply({ text, prompt = null }: { text: string; prompt?: string | null }) {
  const body = useRef<HTMLDivElement>(null);
  const asked = useRef<HTMLParagraphElement>(null);
  const [folded, setFolded] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const cut = (el: HTMLElement | null) => !!el && el.scrollHeight > el.clientHeight;
    setFolded(cut(body.current) || cut(asked.current));
  }, []);
  return (
    <section className={styles.reply}>
      <h3>Claude's latest reply</h3>
      {prompt && (
        <blockquote className={styles.prompt} data-prompt data-full={full || undefined}>
          <span>You</span>
          <p ref={asked}>{prompt}</p>
        </blockquote>
      )}
      <div ref={body} className={styles.body} data-folded={(folded && !full) || undefined} data-full={full || undefined}>
        <Markdown source={text} />
      </div>
      {folded && <button type="button" className={styles.more} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </section>
  );
}
