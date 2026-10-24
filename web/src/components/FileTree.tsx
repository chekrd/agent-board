import type { FileDiffMetadata } from '@pierre/diffs';
import styles from './FileTree.module.css';

interface Dir {
  name: string;
  dirs: Map<string, Dir>;
  files: FileDiffMetadata[];
}

function build(files: FileDiffMetadata[]) {
  const root: Dir = { name: '', dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.name.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, { name: part, dirs: new Map(), files: [] });
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

const counts = (f: FileDiffMetadata) =>
  f.hunks.reduce((sum, h) => ({ add: sum.add + h.additionLines, del: sum.del + h.deletionLines }), { add: 0, del: 0 });

export const fileAnchor = (name: string) => `file-${encodeURIComponent(name)}`;

function Folder({ dir, selected, onSelect }: { dir: Dir; selected: string | null; onSelect: (name: string) => void }) {
  const dirs = [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = dir.files.toSorted((a, b) => a.name.localeCompare(b.name));
  return (
    <ul role="group">
      {dirs.map((d) => (
        <li key={d.name}>
          <details open>
            <summary title={d.name}>{d.name}</summary>
            <Folder dir={d} selected={selected} onSelect={onSelect} />
          </details>
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
              onClick={() => onSelect(f.name)}
            >
              <span className={styles.name}>{f.name.split('/').at(-1)}</span>
              {add > 0 && <span className={styles.add} title="Lines added">+{add}</span>}
              {del > 0 && <span className={styles.del} title="Lines removed">−{del}</span>}
              <span className={styles.status} data-type={f.type} title={typeHints[letter(f)]}>{letter(f)}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

export function FileTree(props: { files: FileDiffMetadata[]; selected: string | null; onSelect: (name: string) => void }) {
  return (
    <nav className={styles.tree} aria-label="Changed files">
      <Folder dir={build(props.files)} selected={props.selected} onSelect={props.onSelect} />
    </nav>
  );
}
