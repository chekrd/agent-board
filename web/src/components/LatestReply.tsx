import { useLayoutEffect, useRef, useState } from 'react';
import styles from './LatestReply.module.css';
import { Markdown } from './Markdown.tsx';

export function LatestReply({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    setFolded(el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <section className={styles.reply}>
      <h3>Claude's latest reply</h3>
      <div ref={body} className={styles.body} data-folded={(folded && !full) || undefined} data-full={full || undefined}>
        <Markdown source={text} />
      </div>
      {folded && <button type="button" className={styles.more} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </section>
  );
}
