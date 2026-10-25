import { parsePatchFiles, registerCustomTheme, type FileDiffMetadata } from '@pierre/diffs';
import type { ThemeRegistration } from 'shiki';
import { FileDiff } from '@pierre/diffs/react';
import { useEffect, useRef, useState, useTransition, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { api } from '../api.ts';
import type { FullDiff } from '../types.ts';
import styles from './DiffView.module.css';
import { fileAnchor, FileTree, treeOrder } from './FileTree.tsx';
import { Icon } from './Icon.tsx';

registerCustomTheme('darcula', async () => (await import('../themes/darcula.json')).default as ThemeRegistration);

// The code keeps the user's Darcula; only the file headers take the board's greys around it.
const FILE_OPTIONS = {
  diffStyle: 'split', theme: 'darcula', themeType: 'dark', overflow: 'scroll', lineDiffType: 'word', stickyHeader: true,
  unsafeCSS: '[data-diffs-header][data-diffs-header] { background-color: #2f2f2f; border-bottom: 1px solid #383838; }',
} as const;

// J and K step through the files of the diff on screen.
let stepper: ((by: 1 | -1) => void) | null = null;

export const stepFile = (by: 1 | -1) => stepper?.(by);

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
  const [focused, setFocused] = useState<string | null>(null);
  const [whole, setWhole] = useState<FileDiffMetadata | null>(null);
  const diffsRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<string | null>(null);
  const seekTo = useRef<string | null>(null);

  const loadWhole = async (file: FileDiffMetadata) => {
    const paths = [file.name, ...(file.prevName ? [file.prevName] : [])].map((p) => `&path=${encodeURIComponent(p)}`).join('');
    const next = await api<FullDiff>('GET', `/api/diff/file?worktree=${encodeURIComponent(worktree)}${paths}`);
    return parsePatchFiles(next.patch).flatMap((p) => p.files).find((f) => f.name === file.name) ?? null;
  };

  const load = () =>
    startLoading(async () => {
      try {
        const next = await api<FullDiff>('GET', `/api/diff?worktree=${encodeURIComponent(worktree)}`);
        const file = focused ? parsePatchFiles(next.patch).flatMap((p) => p.files).find((f) => f.name === focused) : undefined;
        const nextWhole = file ? await loadWhole(file) : null;
        startLoading(() => {
          setDiff(next);
          setWhole(nextWhole);
          if (!file) setFocused(null);
          setError(null);
        });
      } catch (err) {
        setError((err as Error).message);
      }
    });

  useEffect(load, [worktree]);

  const focus = (name: string) => {
    const file = files.find((f) => f.name === name);
    if (!file) return;
    setFocused(name);
    setSelected(name);
    seekTo.current = name;
    diffsRef.current?.scrollTo({ top: 0 });
    startLoading(async () => {
      try {
        const next = await loadWhole(file);
        startLoading(() => setWhole(next));
      } catch (err) {
        setError((err as Error).message);
      }
    });
  };

  const showAll = () => {
    returnTo.current = focused;
    setFocused(null);
    setWhole(null);
  };

  // The diff renders into a shadow root after highlighting, so wait for its first changed line.
  useEffect(() => {
    if (!whole || whole.name !== seekTo.current) return;
    let frame = 0;
    const started = performance.now();
    const seek = () => {
      const line = diffsRef.current?.querySelector('diffs-container')?.shadowRoot?.querySelector('[data-line-type^="change-"]');
      if (!line && performance.now() - started < 2000) frame = requestAnimationFrame(seek);
      else {
        line?.scrollIntoView({ block: 'center' });
        seekTo.current = null;
      }
    };
    seek();
    return () => cancelAnimationFrame(frame);
  }, [whole]);

  useEffect(() => {
    if (focused || !returnTo.current) return;
    document.getElementById(fileAnchor(returnTo.current))?.scrollIntoView();
    returnTo.current = null;
  }, [focused]);

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

  const files = diff ? treeOrder(parsePatchFiles(diff.patch).flatMap((p) => p.files)) : [];
  const shown = focused ? [whole?.name === focused ? whole : files.find((f) => f.name === focused)].filter((f) => !!f) : files;

  // From all files, J opens the file in view and K the one before it.
  useEffect(() => {
    stepper = (by) => {
      const order = files.map((f) => f.name);
      const from = order.indexOf(focused ?? selected ?? order[0]);
      const to = focused ? from + by : by === 1 ? from : from - 1;
      const name = order[Math.max(0, Math.min(order.length - 1, to))];
      if (name && name !== focused) focus(name);
    };
    return () => {
      stepper = null;
    };
  });

  // Esc in one file goes back to all files and keeps the sheet open.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      showAll();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    const root = diffsRef.current;
    if (!root || focused) return;
    const observer = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setSelected((top.target as HTMLElement).dataset.file ?? null);
    }, { root, rootMargin: '0px 0px -85% 0px' });
    for (const section of root.querySelectorAll('section')) observer.observe(section);
    return () => observer.disconnect();
  }, [diff, focused]);

  return (
    <div className={styles.frame}>
      <div className={styles.view} data-theme="dark">
        <div className={styles.toolbar}>
          {focused && (
            <>
              <button type="button" className={styles.tool} onClick={showAll}>← All files</button>
              <code className={styles.path}>{focused}</code>
            </>
          )}
          {diff && !focused && (
            <span className={styles.stat}>
              <span>{diff.stat.files} files</span> · <span className={styles.add}>+{diff.stat.insertions}</span>{' '}
              <span className={styles.del}>−{diff.stat.deletions}</span> against{' '}
              <code>{diff.base}</code> @{' '}
              <code title="The commit where this branch left the base branch">{diff.mergeBase.slice(0, 8)}</code>
            </span>
          )}
          <span className={styles.hint} title="The diff merges everything in the worktree, whether committed or not">{focused ? 'whole file' : 'committed + staged + unstaged + untracked'}</span>
          <button type="button" className={styles.tool} onClick={load} disabled={loading}>
            <Icon name="refresh" size={14} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {error && <p className={styles.error}>{error}</p>}
        <div className={styles.content} style={{ '--tree-width': `${treeWidth}px` } as CSSProperties}>
          {files.length > 0 && (
            <>
              <FileTree files={files} selected={focused ?? selected} onSelect={focus} />
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
            {shown.map((f) => (
              <section key={f.name} id={fileAnchor(f.name)} data-file={f.name} className={styles.file}>
                <FileDiff fileDiff={f} options={FILE_OPTIONS} />
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
