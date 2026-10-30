import type { FileDiffMetadata } from '@pierre/diffs';
import { useState, type Ref } from 'react';
import styles from './FileTree.module.css';
import { Icon } from './Icon.tsx';

interface Dir {
  name: string;
  path: string;
  dirs: Map<string, Dir>;
  files: FileDiffMetadata[];
}

function build(files: FileDiffMetadata[]) {
  const root: Dir = { name: '', path: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.name.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, path: dir.path ? `${dir.path}/${part}` : part, dirs: new Map(), files: [] });
      dir = dir.dirs.get(part)!;
    }
    dir.files.push(f);
  }
  return compact(root);
}

function compact(dir: Dir): Dir {
  const dirs = new Map([...dir.dirs].map(([k, d]) => [k, compact(d)]));
  const [only] = dirs.values();
  if (dir.name && dirs.size === 1 && !dir.files.length) return { ...only, name: `${dir.name}/${only.name}` };
  return { ...dir, dirs };
}

const typeHints = { A: 'Added', D: 'Deleted', R: 'Renamed', M: 'Modified' };

const letter = (f: FileDiffMetadata) => (f.type === 'new' ? 'A' : f.type === 'deleted' ? 'D' : f.type.startsWith('rename') ? 'R' : 'M');

export const counts = (f: FileDiffMetadata) =>
  f.hunks.reduce((sum, h) => ({ add: sum.add + h.additionLines, del: sum.del + h.deletionLines }), { add: 0, del: 0 });

const sortedDirs = (dir: Dir) => [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
const sortedFiles = (dir: Dir) => dir.files.toSorted((a, b) => a.name.localeCompare(b.name));

const flatten = (dir: Dir): FileDiffMetadata[] => [...sortedDirs(dir).flatMap(flatten), ...sortedFiles(dir)];

export const treeOrder = (files: FileDiffMetadata[]) => flatten(build(files));

export const fileAnchor = (name: string) => `file-${encodeURIComponent(name)}`;

export const inDir = (dir: string | null) => (f: FileDiffMetadata) => !dir || f.name.startsWith(`${dir}/`);

export const matching = (query: string) => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return (f: FileDiffMetadata) => terms.every((t) => f.name.toLowerCase().includes(t) || !!f.prevName?.toLowerCase().includes(t));
};

interface Picks {
  selected: string | null;
  dir: string | null;
  onSelect: (name: string) => void;
  onDir: (path: string) => void;
  collapsed: Set<string>;
  onToggle: (path: string) => void;
}

function Folder({ node, ...picks }: Picks & { node: Dir }) {
  const { selected, dir, onSelect, onDir, collapsed, onToggle } = picks;
  const dirs = sortedDirs(node);
  const files = sortedFiles(node);
  return (
    <ul role="group">
      {dirs.map((d) => (
        <li key={d.name}>
          <div className={styles.folder}>
            <button
              type="button"
              className={styles.twisty}
              aria-expanded={!collapsed.has(d.path)}
              aria-label={`${collapsed.has(d.path) ? 'Expand' : 'Collapse'} ${d.path}/`}
              title={collapsed.has(d.path) ? 'Expand' : 'Collapse'}
              onClick={() => onToggle(d.path)}
            >
              <Icon name={collapsed.has(d.path) ? 'chevron-right' : 'chevron-down'} size={14} />
            </button>
            <button type="button" className={styles.dir} aria-pressed={dir === d.path} title={`Show only the changes in ${d.path}/`} onClick={() => onDir(d.path)}>
              <Icon name="folder" size={14} />
              <span className={styles.name}>{d.name}</span>
            </button>
          </div>
          {!collapsed.has(d.path) && <Folder node={d} {...picks} />}
        </li>
      ))}
      {files.map((f) => {
        const { add, del } = counts(f);
        return (
          <li key={f.name}>
            <a
              href={`#${fileAnchor(f.name)}`}
              aria-current={selected === f.name || undefined}
              title={f.prevName ? `${f.prevName} → ${f.name}` : f.name}
              onClick={(e) => {
                e.preventDefault();
                onSelect(f.name);
              }}
            >
              <span className={styles.name}>{f.name.split('/').at(-1)}</span>
              {add > 0 && <span className={styles.add}>+{add}</span>}
              {del > 0 && <span className={styles.del}>−{del}</span>}
              <span className={styles.status} data-type={f.type} data-letter={letter(f)} title={typeHints[letter(f)]}>{letter(f)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

interface TreeProps extends Omit<Picks, 'collapsed' | 'onToggle'> {
  files: FileDiffMetadata[];
  all: boolean;
  onAll: () => void;
  query: string;
  onQuery: (query: string) => void;
  filterRef: Ref<HTMLInputElement>;
}

export function FileTree({ files, all, onAll, query, onQuery, filterRef, ...picks }: TreeProps) {
  const [collapsed, setCollapsed] = useState(() => new Set<string>());
  const [shown, setShown] = useState(picks.selected);
  if (shown !== picks.selected) {
    setShown(picks.selected);
    const { selected } = picks;
    if (selected && [...collapsed].some((p) => selected.startsWith(`${p}/`))) setCollapsed(new Set([...collapsed].filter((p) => !selected.startsWith(`${p}/`))));
  }
  const onToggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  const found = query ? files.filter(matching(query)) : files;
  return (
    <nav className={styles.tree} aria-label="Changed files">
      <div className={styles.filter}>
        <Icon name="search" size={14} />
        <input
          ref={filterRef}
          type="search"
          value={query}
          placeholder="Filter files"
          aria-label="Filter files by name"
          title="Show only the files whose path holds every word typed; Esc clears"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => onQuery(e.target.value)}
        />
      </div>
      <button type="button" className={styles.all} aria-pressed={all} onClick={onAll}>
        All files <span>{query ? `${found.length} of ${files.length}` : files.length}</span>
      </button>
      {found.length ? <Folder node={build(found)} {...picks} collapsed={collapsed} onToggle={onToggle} /> : <p className={styles.none}>No file matches.</p>}
    </nav>
  );
}
