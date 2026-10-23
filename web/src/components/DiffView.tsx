import { parsePatchFiles, registerCustomTheme } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { api } from '../api.ts';
import type { FullDiff } from '../types.ts';
import styles from './DiffView.module.css';
import { fileAnchor, FileTree } from './FileTree.tsx';

registerCustomTheme('darcula', async () => (await import('../themes/darcula.json')).default as ThemeRegistration);

const THEME = { dark: 'darcula', light: 'light-plus' };

type Layout = 'split' | 'unified';

function storedLayout(): Layout {
  try {
    return localStorage.getItem('diff-layout') === 'unified' ? 'unified' : 'split';
  } catch {
    return 'split';
  }
}

export function DiffView({ worktree }: { worktree: string }) {
  const [diff, setDiff] = useState<FullDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layout, setLayout] = useState<Layout>(storedLayout);
  const [loading, startLoading] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const diffsRef = useRef<HTMLDivElement>(null);

  const load = () =>
    startLoading(async () => {
      try {
        const next = await api<FullDiff>('GET', `/api/diff?worktree=${encodeURIComponent(worktree)}`);
        startLoading(() => {
          setDiff(next);
          setError(null);
        });
      } catch (err) {
        setError((err as Error).message);
      }
    });

  useEffect(load, [worktree]);

  const toggleLayout = () => {
    const next = layout === 'split' ? 'unified' : 'split';
    setLayout(next);
    try {
      localStorage.setItem('diff-layout', next);
    } catch {
      // per-viewer convenience only
    }
  };

  const files = diff ? parsePatchFiles(diff.patch).flatMap((p) => p.files) : [];

  useEffect(() => {
    const root = diffsRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setSelected((top.target as HTMLElement).dataset.file ?? null);
    }, { root, rootMargin: '0px 0px -85% 0px' });
    for (const section of root.querySelectorAll('section')) observer.observe(section);
    return () => observer.disconnect();
  }, [diff, layout]);

  return (
    <div className={styles.view}>
      <div className={styles.toolbar}>
        {diff && (
          <span>
            {diff.stat.files} files · <span className={styles.add}>+{diff.stat.insertions}</span>{' '}
            <span className={styles.del}>−{diff.stat.deletions}</span> against <code>{diff.base}</code> @ <code>{diff.mergeBase.slice(0, 8)}</code>
          </span>
        )}
        <span className={styles.hint}>committed + staged + unstaged + untracked</span>
        <button data-variant="ghost" onClick={toggleLayout}>{layout === 'split' ? 'Unified' : 'Split'}</button>
        <button onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.content}>
        {files.length > 0 && <FileTree files={files} selected={selected} onSelect={setSelected} />}
        <div className={styles.diffs} ref={diffsRef}>
          {diff && !files.length && <p className={styles.empty}>No changes against {diff.base}.</p>}
          {files.map((f) => (
            <section key={f.name} id={fileAnchor(f.name)} data-file={f.name} className={styles.file}>
              <FileDiff fileDiff={f} options={{ diffStyle: layout, theme: THEME, overflow: 'scroll', lineDiffType: 'word' }} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
