import { parsePatchFiles } from '@pierre/diffs';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useState, useTransition } from 'react';
import { api } from '../api.ts';
import type { FullDiff } from '../types.ts';
import styles from './DiffView.module.css';

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
        {files.length > 0 && (
          <nav className={styles.files}>
            {files.map((f) => (
              <a key={f.name} href={`#file-${encodeURIComponent(f.name)}`} title={f.prevName ? `${f.prevName} → ${f.name}` : f.name}>
                <span data-type={f.type}>{f.type === 'new' ? 'A' : f.type === 'deleted' ? 'D' : f.type.startsWith('rename') ? 'R' : 'M'}</span>
                {f.name}
              </a>
            ))}
          </nav>
        )}
        <div className={styles.diffs}>
          {diff && !files.length && <p className={styles.empty}>No changes against {diff.base}.</p>}
          {files.map((f) => (
            <section key={f.name} id={`file-${encodeURIComponent(f.name)}`} className={styles.file}>
              <FileDiff fileDiff={f} options={{ diffStyle: layout, theme: { dark: 'pierre-dark', light: 'pierre-light' }, overflow: 'scroll' }} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
