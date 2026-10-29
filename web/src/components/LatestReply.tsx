import { useLayoutEffect, useRef, useState } from 'react';
import styles from './LatestReply.module.css';
import { Markdown } from './Markdown.tsx';

export function LatestReply({ text, prompt = null }: { text: string; prompt?: string | null }) {
  const asked = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = asked.current;
    setCut(!!el && el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <section className={styles.reply}>
      <h3>Claude's latest reply</h3>
      {prompt && (
        <blockquote className={styles.prompt} data-prompt data-full={full || undefined}>
          <span>You</span>
          <p ref={asked}>{prompt}</p>
          {cut && <button type="button" className={styles.more} onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
        </blockquote>
      )}
      <div className={styles.body}>
        <Markdown source={text} />
      </div>
    </section>
  );
}
