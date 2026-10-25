import { useActionState, useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { api } from '../api.ts';
import { openSheet, type View } from '../router.ts';
import type { RepoView } from '../types.ts';
import { Icon } from './Icon.tsx';
import styles from './NewTaskForm.module.css';

interface Fields {
  prompt: string;
  repoId: number | null;
  name: string;
  branch: string;
  path: string;
  existing: boolean;
  start: boolean;
  more: boolean;
}

interface Branch {
  name: string;
  worktree: string | null;
}

const INLINE = 'new-task-inline';
const DIALOG = 'new-task';
const STORED = 'agent-board:new-task';
const EMPTY: Fields = { prompt: '', repoId: null, name: '', branch: '', path: '', existing: false, start: true, more: false };
const NAME = /^[A-Za-z0-9._/-]+$/;

function stored(): Fields {
  try {
    const raw = sessionStorage.getItem(STORED);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

// Both hosts show the same fields, so a prompt begun on the Wall is there over the queue, and a reload keeps it.
let fields = stored();
// They share the branch list too: both are mounted at once, and one read serves them.
let branches: { repoId: number; list: Branch[] } | null = null;
let reading: number | null = null;
const subscribers = new Set<() => void>();

const notify = () => {
  for (const fn of subscribers) fn();
};

function edit(patch: Partial<Fields>) {
  fields = { ...fields, ...patch };
  try {
    sessionStorage.setItem(STORED, JSON.stringify(fields));
  } catch {
    // A page without storage keeps them in memory only.
  }
  notify();
}

function readBranches(repoId: number) {
  if (reading === repoId) return;
  reading = repoId;
  api<Branch[]>('GET', `/api/repos/${repoId}/branches`).catch(() => []).then((list) => {
    if (reading !== repoId) return;
    reading = null;
    branches = { repoId, list };
    notify();
  });
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

// On the Wall the form is already on the page; over the queue it opens as a dialog.
export function openNewTask(view: View) {
  const inline = document.querySelector<HTMLTextAreaElement>(`#${INLINE} textarea`);
  if (view === 'wall' && inline) return inline.focus();
  const dialog = document.getElementById(DIALOG) as HTMLDialogElement | null;
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  dialog.querySelector('textarea')?.focus();
}

function NewTaskForm({ repos, accent, inline, done }: { repos: RepoView[]; accent: boolean; inline: boolean; done?: () => void }) {
  const f = useSyncExternalStore(subscribe, () => fields);
  const read = useSyncExternalStore(subscribe, () => branches);
  const repo = repos.find((r) => r.id === f.repoId) ?? repos[0];
  useEffect(() => {
    if (f.existing) readBranches(repo.id);
  }, [f.existing, repo.id]);

  const name = f.name.trim();
  const branch = f.branch.trim();
  const valid = f.existing ? !!branch : NAME.test(name);
  const main = repo.worktrees.find((w) => w.isMain);
  const list = read?.repoId === repo.id ? read.list : [];
  const picked = list.find((b) => b.name === branch);
  const chips = f.existing ? list.filter((b) => b.name !== branch && b.name.includes(branch)) : [];

  const [error, create, pending] = useActionState(async () => {
    const now = fields;
    try {
      const result = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', {
        repoId: repo.id,
        name: now.existing ? '' : now.name.trim(),
        branch: now.branch.trim(),
        path: now.path.trim(),
        prompt: now.prompt,
        startClaude: now.start,
        existingBranch: now.existing,
      });
      edit({ ...EMPTY, repoId: repo.id });
      done?.();
      if (result.sessionId) openSheet(result.sessionId);
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);

  const onPromptKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (valid && !pending) e.currentTarget.form?.requestSubmit();
    } else if (e.key === 'Escape' && inline) {
      e.currentTarget.blur();
    }
  };

  const where = (b: Branch) => (!b.worktree ? '' : b.worktree === main?.path ? 'main checkout' : 'own worktree');
  const folder = repo.path.split('/').at(-1);

  return (
    <form className={styles.form} action={create}>
      <textarea
        className={styles.prompt}
        rows={1}
        aria-label="What should Claude work on?"
        placeholder="What should Claude work on?"
        value={f.prompt}
        onChange={(e) => edit({ prompt: e.currentTarget.value })}
        onKeyDown={onPromptKey}
      />
      <div className={styles.row}>
        <select className={styles.repo} aria-label="Repository" value={repo.id} onChange={(e) => edit({ repoId: Number(e.currentTarget.value), branch: '' })}>
          <button type="button" className={styles.picked}>
            <span className={styles.caption}>Repository</span>
            <strong>{repo.name}</strong>
            <Icon name="chevron-down" size={14} />
          </button>
          {repos.map((r) => (
            <option key={r.id} value={r.id}>
              <strong>{r.name}</strong>
              <code>{r.path}</code>
            </option>
          ))}
        </select>
        {f.existing ? (
          <label className={styles.field}>
            <span className={styles.caption}>Branch</span>
            <input value={f.branch} onChange={(e) => edit({ branch: e.currentTarget.value })} placeholder="Pick or type to filter" spellCheck={false} autoComplete="off" />
          </label>
        ) : (
          <label className={styles.field} title="Names the worktree folder, and the branch unless you set one">
            <span className={styles.caption}>Name</span>
            <input value={f.name} onChange={(e) => edit({ name: e.currentTarget.value })} placeholder="fix-login-redirect" spellCheck={false} autoComplete="off" />
          </label>
        )}
        <button type="button" className={styles.more} aria-expanded={f.more} onClick={() => edit({ more: !f.more })}>
          More options <Icon name="chevron-down" size={14} />
        </button>
        <button type="submit" className={styles.create} data-accent={accent || undefined} disabled={!valid || pending}>
          {pending ? 'Creating…' : 'Create'} <kbd>⌘↵</kbd>
        </button>
      </div>
      {chips.length > 0 && (
        <div className={styles.chips} role="listbox" aria-label="Branches">
          {chips.map((b) => (
            <button key={b.name} type="button" role="option" aria-selected={false} onClick={() => edit({ branch: b.name })}>
              <code>{b.name}</code>
              {where(b) && <span>{where(b)}</span>}
            </button>
          ))}
        </div>
      )}
      {f.more && (
        <div className={styles.options}>
          <fieldset>
            <legend>Where Claude runs</legend>
            <label><input type="radio" name="mode" checked={!f.existing} onChange={() => edit({ existing: false, branch: '' })} /> New worktree</label>
            <label><input type="radio" name="mode" checked={f.existing} onChange={() => edit({ existing: true, branch: '' })} /> Existing branch, no worktree</label>
          </fieldset>
          {!f.existing && (
            <>
              <label className={styles.input} title="The new branch; defaults to the name">
                <span>Branch</span>
                <input value={f.branch} onChange={(e) => edit({ branch: e.currentTarget.value })} placeholder={name || 'same as name'} spellCheck={false} />
              </label>
              <label className={styles.input} title="Where the worktree is created; defaults to the repository's worktree folder">
                <span>Worktree path</span>
                <input value={f.path} onChange={(e) => edit({ path: e.currentTarget.value })} placeholder={`${repo.worktreeRoot ?? repo.defaultWorktreeRoot}/${name || '<name>'}/${folder}`} spellCheck={false} />
              </label>
            </>
          )}
          <label className={styles.check}><input type="checkbox" checked={f.start} onChange={(e) => edit({ start: e.currentTarget.checked })} /> Start a Claude session</label>
        </div>
      )}
      <p className={styles.hint}>
        {f.existing ? (
          picked?.worktree ? <>Starts Claude in <code>{picked.worktree}</code>, where it is checked out.</>
            : <>Switches <code>{main?.path ?? repo.path}</code> to {branch ? <code>{branch}</code> : 'the branch'} and starts Claude there.</>
        ) : !f.start ? (
          'Off: only the worktree and a shell tab are created.'
        ) : (
          <>Branches from <code>{repo.base}</code> and starts Claude there.{repo.setupCommand && <> Runs <code>{repo.setupCommand}</code> there first.</>}</>
        )}
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function NewTaskInline({ repos, accent }: { repos: RepoView[]; accent: boolean }) {
  return (
    <section id={INLINE} aria-label="New task" className={styles.inline}>
      <NewTaskForm repos={repos} accent={accent} inline />
    </section>
  );
}

export function NewTaskDialog({ repos }: { repos: RepoView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <dialog id={DIALOG} ref={dialog} closedby="any" aria-label="New task" className={styles.dialog}>
      {repos.length > 0 && <NewTaskForm repos={repos} accent={false} inline={false} done={() => dialog.current?.close()} />}
    </dialog>
  );
}
