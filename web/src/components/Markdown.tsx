import { marked } from 'marked';
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { tildeIn } from '../util.ts';
import styles from './Markdown.module.css';

export function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { home } = useStore();
  useLayoutEffect(() => {
    ref.current?.setHTML(marked.parse(tildeIn(source, home), { async: false }));
  }, [source, home]);
  return <div ref={ref} className={styles.markdown} />;
}
