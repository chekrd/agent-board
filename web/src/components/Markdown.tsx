import { marked } from 'marked';
import type { BundledLanguage } from 'shiki';
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../store.ts';
import { tildeIn } from '../util.ts';
import styles from './Markdown.module.css';

// Shiki's light-dark() colours follow the page's color-scheme, so the code changes with the board's theme. The spans are
// built here rather than from Shiki's HTML so the text never goes through innerHTML. setHTML drops marked's language-*
// class, so each block's language comes from its token, in document order.
async function highlight(root: HTMLElement, langs: string[], live: () => boolean) {
  const blocks = [...root.querySelectorAll<HTMLElement>('pre > code')].map((code, i) => ({ code, lang: langs[i]?.split(/\s/)[0] }));
  if (!blocks.some((b) => b.lang)) return;
  const { codeToTokens } = await import('shiki');
  for (const { code, lang } of blocks) {
    if (!lang) continue;
    const tokens = await codeToTokens(code.textContent!.replace(/\n$/, ''), {
      lang: lang as BundledLanguage, themes: { light: 'github-light-high-contrast', dark: 'github-dark' }, defaultColor: 'light-dark()',
    }).catch(() => null);
    if (!live()) return;
    if (!tokens) continue;
    code.replaceChildren(...tokens.tokens.flatMap((line, i) => [
      ...(i ? ['\n'] : []),
      ...line.map((t) => {
        const span = document.createElement('span');
        span.textContent = t.content;
        span.style.color = t.htmlStyle?.color ?? '';
        if (t.htmlStyle?.['font-style']) span.style.fontStyle = t.htmlStyle['font-style'];
        if (t.htmlStyle?.['font-weight']) span.style.fontWeight = t.htmlStyle['font-weight'];
        return span;
      }),
    ]));
  }
}

export function Markdown({ source }: { source: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { home } = useStore();
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const langs: string[] = [];
    el.setHTML(marked.parse(tildeIn(source, home), { async: false, walkTokens: (t) => { if (t.type === 'code') langs.push(t.lang ?? ''); } }));
    let live = true;
    void highlight(el, langs, () => live);
    return () => { live = false; };
  }, [source, home]);
  return <div ref={ref} className={styles.markdown} />;
}
