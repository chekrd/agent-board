import { marked } from 'marked';
import { useLayoutEffect, useRef } from 'react';
import styles from './Markdown.module.css';

export function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.setHTML(marked.parse(source, { async: false }));
  }, [source]);
  return <div ref={ref} className={styles.markdown} />;
}
