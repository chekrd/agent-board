import { parsePatchFiles, registerCustomTheme } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../api.ts';
import type { FullDiff } from '../types.ts';
import styles from './DiffView.module.css';
import { fileAnchor, FileTree } from './FileTree.tsx';

registerCustomTheme('darcula', async () => (await import('../themes/darcula.json')).default as ThemeRegistration);

const THEME = 'darcula';

const TREE_WIDTH = 260;
const TREE_MIN = 140;
const TREE_MAX = 640;

const clampWidth = (w: number) => Math.round(Math.min(TREE_MAX, Math.max(TREE_MIN, w)));

function storedTreeWidth() {
  try {
    const w = Number(localStorage.getItem('diff-tree-width'));
    return w ? clampWidth(w) : TREE_WIDTH;
  } catch {
    return TREE_WIDTH;
  }
}

function storeTreeWidth(w: number) {
  try {
    localStorage.setItem('diff-tree-width', String(w));
  } catch {
    // per-viewer convenience only
  }
}

export function DiffView({ worktree }: { worktree: string }) {
  const [diff, setDiff] = useState<FullDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [treeWidth, setTreeWidth] = useState(storedTreeWidth);
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

  const resizeTo = (w: number) => {
    const next = clampWidth(w);
    setTreeWidth(next);
    storeTreeWidth(next);
  };

  const startResize = (e: PointerEvent<HTMLDivElement>) => {
    const handle = e.currentTarget;
    const left = handle.parentElement!.getBoundingClientRect().left;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: globalThis.PointerEvent) => resizeTo(ev.clientX - left);
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const resizeByKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    if (e.key === 'ArrowLeft') resizeTo(treeWidth - step);
    else if (e.key === 'ArrowRight') resizeTo(treeWidth + step);
    else return;
    e.preventDefault();
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
  }, [diff]);

  return (
    <div className={styles.view} data-theme="dark">
      <div className={styles.toolbar}>
        {diff && (
          <span>
            <span>{diff.stat.files} files</span> · <span className={styles.add}>+{diff.stat.insertions}</span>{' '}
            <span className={styles.del}>−{diff.stat.deletions}</span> against{' '}
            <code>{diff.base}</code> @{' '}
            <code title="The commit where this branch left the base branch">{diff.mergeBase.slice(0, 8)}</code>
          </span>
        )}
        <span className={styles.hint} title="The diff merges everything in the worktree, whether committed or not">committed + staged + unstaged + untracked</span>
        <button onClick={load} disabled={loading}>{loading ? 'Loading…' : 'Refresh'}</button>
      </div>
      {error && <p className={styles.error}>{error}</p>}
      <div className={styles.content} style={{ '--tree-width': `${treeWidth}px` } as CSSProperties}>
        {files.length > 0 && (
          <>
            <FileTree files={files} selected={selected} onSelect={setSelected} />
            <div
              className={styles.resizer}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file list"
              aria-valuenow={treeWidth}
              aria-valuemin={TREE_MIN}
              aria-valuemax={TREE_MAX}
              tabIndex={0}
              title="Drag to resize the file list; double-click to reset"
              onPointerDown={startResize}
              onKeyDown={resizeByKey}
              onDoubleClick={() => resizeTo(TREE_WIDTH)}
            />
          </>
        )}
        <div className={styles.diffs} ref={diffsRef}>
          {diff && !files.length && <p className={styles.empty}>No changes against {diff.base}.</p>}
          {files.map((f) => (
            <section key={f.name} id={fileAnchor(f.name)} data-file={f.name} className={styles.file}>
              <FileDiff fileDiff={f} options={{ diffStyle: 'split', theme: THEME, themeType: 'dark', overflow: 'scroll', lineDiffType: 'word' }} />
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
