import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ToggleEvent } from 'react';
import { api } from '../api.ts';
import { keepUnderLayer } from '../layers.ts';
import { openSheet } from '../router.ts';
import type { RepoView } from '../types.ts';
import { EFFORTS, effortName, modelName } from '../util.ts';
import { Icon } from './Icon.tsx';
import styles from './NewTaskForm.module.css';

interface Fields {
  prompt: string;
  repoId: number | null;
  name: string;
  branch: string;
  path: string;
  existing: boolean;
  model: string;
  effort: string;
}

// What each choice of model comes to, '' being what Claude Code picks by itself, and the effort it starts with.
interface Models {
  models: Record<string, string | null>;
  efforts: Record<string, string | null>;
}

interface Branch {
  name: string;
  worktree: string | null;
}

const DIALOG = 'new-task';
const STORED = 'agent-board:new-task';
const EMPTY: Fields = { prompt: '', repoId: null, name: '', branch: '', path: '', existing: false, model: '', effort: '' };

const NAME = /^[A-Za-z0-9._/-]+$/;
const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

function stored(): Fields {
  try {
    const raw = sessionStorage.getItem(STORED);
    return raw ? { ...EMPTY, ...JSON.parse(raw) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

// A prompt begun and closed is there when New task opens again, and a reload keeps it; the name starts empty each time.
let fields = stored();
// They share the branch list too: both are mounted at once, and one read serves them.
let branches: { repoId: number; list: Branch[] } | null = null;
let reading: number | null = null;
let models: { repoId: number; read: Models } | null = null;
let readingModels: number | null = null;
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
    branches = { repoId, list: list.toSorted((a, b) => byName(a.name, b.name)) };
    notify();
  });
}

function readModels(repoId: number) {
  if (readingModels === repoId || models?.repoId === repoId) return;
  readingModels = repoId;
  api<Models>('GET', `/api/repos/${repoId}/models`).catch(() => ({ models: {}, efforts: {} })).then((read) => {
    if (readingModels !== repoId) return;
    readingModels = null;
    models = { repoId, read };
    notify();
  });
}

const defaultBranch = (repo: RepoView) => (repo.base === 'HEAD' ? '' : repo.base.replace(/^origin\//, ''));

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

// New task opens as a dialog over either view.
export function openNewTask() {
  const dialog = document.getElementById(DIALOG) as HTMLDialogElement | null;
  if (!dialog) return;
  if (!dialog.open) {
    edit({ name: '' });
    dialog.showModal();
  }
  dialog.querySelector('textarea')?.focus();
}

// Typing on the closed button opens the list with that letter already in the filter.
function RepoPicker({ repos, repo, pick }: { repos: RepoView[]; repo: RepoView; pick: (id: number) => void }) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const filter = useRef<HTMLInputElement>(null);
  const seed = useRef('');
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const q = query.trim().toLowerCase();
  const shown = q ? repos.filter((r) => r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q)) : repos;
  const at = Math.min(active, shown.length - 1);
  const activeId = shown[at] && `${id}-${shown[at].id}`;

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const choose = (r: RepoView) => {
    pick(r.id);
    list.current?.hidePopover();
  };

  const onToggle = (e: ToggleEvent<HTMLDivElement>) => {
    if (e.newState !== 'open') return;
    setQuery(seed.current);
    setActive(seed.current ? 0 : Math.max(0, repos.indexOf(repo)));
    seed.current = '';
    filter.current?.focus();
  };

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    const letter = e.key.length === 1 && e.key !== ' ' && !e.metaKey && !e.ctrlKey && !e.altKey;
    if (!letter && e.key !== 'ArrowDown') return;
    e.preventDefault();
    if (letter) seed.current = e.key;
    list.current?.showPopover();
  };

  const onFilterKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length) setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    }
  };

  return (
    <>
      <button type="button" className={styles.repo} popoverTarget={`${id}-list`} aria-haspopup="listbox" aria-label={`Repository: ${repo.name}`} onKeyDown={onButtonKey}>
        <span className={styles.caption}>Repository</span>
        <strong>{repo.name}</strong>
        <Icon name="chevron-down" size={14} />
      </button>
      <div id={`${id}-list`} ref={list} popover="auto" className={styles.picker} onToggle={onToggle} data-repo-picker>
        <input
          ref={filter}
          className={styles.filter}
          role="combobox"
          aria-label="Filter repositories"
          aria-expanded
          aria-controls={`${id}-options`}
          aria-activedescendant={activeId}
          placeholder="Filter repositories"
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onFilterKey}
          spellCheck={false}
          autoComplete="off"
        />
        <div id={`${id}-options`} role="listbox" aria-label="Repositories" className={styles.repos}>
          {shown.map((r, i) => (
            <button
              key={r.id}
              id={`${id}-${r.id}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={r.id === repo.id}
              data-active={i === at || undefined}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(r)}
            >
              <strong>{r.name}</strong>
              <code>{r.path}</code>
            </button>
          ))}
          {shown.length === 0 && <p className={styles.none}>No repository matches “{query.trim()}”</p>}
        </div>
      </div>
    </>
  );
}

// The list opens on a click, a typed letter or ↓, and scrolls inside itself, so many branches never push the form away.
function BranchPicker({ branches, value, pick, where }: { branches: Branch[] | null; value: string; pick: (name: string) => void; where: (b: Branch) => string }) {
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = value.trim().toLowerCase();
  const all = branches ?? [];
  const exact = all.some((b) => b.name.toLowerCase() === q);
  const shown = q && !exact ? all.filter((b) => b.name.toLowerCase().includes(q)) : all;
  const at = Math.min(active, shown.length - 1);
  const activeId = open && shown[at] ? `${id}-${at}` : undefined;

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    if (open && !el.matches(':popover-open')) el.showPopover();
    if (!open && el.matches(':popover-open')) el.hidePopover();
  }, [open]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' });
  }, [activeId]);

  const show = () => {
    if (open) return;
    setActive(Math.max(0, shown.findIndex((b) => b.name.toLowerCase() === q)));
    setOpen(true);
  };

  const choose = (b: Branch) => {
    pick(b.name);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return show();
      if (shown.length) setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && open) {
      e.preventDefault();
      if (shown[at]) choose(shown[at]);
    } else if (e.key === 'Escape' && open) {
      // Closes only the list, not the dialog around it.
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <>
      <label className={styles.field} data-branch-field>
        <span className={styles.caption}>Branch</span>
        <input
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-activedescendant={activeId}
          value={value}
          onChange={(e) => {
            pick(e.currentTarget.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(e) => e.currentTarget.select()}
          onClick={show}
          onKeyDown={onKey}
          onBlur={() => setOpen(false)}
          placeholder="Pick or type to filter"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
        <div id={`${id}-list`} ref={list} popover="manual" role="listbox" aria-label="Branches" className={styles.branches} data-branch-picker>
          {shown.map((b, i) => (
            <button
              key={b.name}
              id={`${id}-${i}`}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={b.name.toLowerCase() === q}
              data-active={i === at || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onPointerMove={() => setActive(i)}
              onClick={() => choose(b)}
            >
              <code>{b.name}</code>
              {where(b) && <span>{where(b)}</span>}
            </button>
          ))}
          {shown.length === 0 && (
            <p className={styles.none}>{!branches ? 'Reading branches…' : all.length ? <>No branch matches “{value.trim()}”</> : 'No branches'}</p>
          )}
        </div>
    </>
  );
}

function NewTaskForm({ repos, done }: { repos: RepoView[]; done?: () => void }) {
  const f = useSyncExternalStore(subscribe, () => fields);
  const read = useSyncExternalStore(subscribe, () => branches);
  const known = useSyncExternalStore(subscribe, () => models);
  const sorted = repos.toSorted((a, b) => byName(a.name, b.name));
  const repo = repos.find((r) => r.id === f.repoId) ?? repos[0];
  useEffect(() => {
    if (f.existing) readBranches(repo.id);
  }, [f.existing, repo.id]);
  useEffect(() => readModels(repo.id), [repo.id]);

  const name = f.name.trim();
  const branch = f.branch.trim();
  const valid = f.existing ? !!branch : NAME.test(name);
  const main = repo.worktrees.find((w) => w.isMain);
  const list = read?.repoId === repo.id ? read.list : null;
  const picked = list?.find((b) => b.name === branch);

  const [error, create, pending] = useActionState(async () => {
    const now = fields;
    try {
      const result = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', {
        repoId: repo.id,
        name: now.existing ? '' : now.name.trim(),
        branch: now.branch.trim(),
        path: now.path.trim(),
        prompt: now.prompt,
        existingBranch: now.existing,
        model: now.model,
        effort: now.effort,
      });
      edit({ ...EMPTY, repoId: repo.id, existing: now.existing, branch: now.existing ? defaultBranch(repo) : '', model: now.model, effort: now.effort });
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
    }
  };

  const choices = known?.repoId === repo.id ? known.read : null;
  const real = (value: string) => choices?.models[value] ?? null;
  const modelOptions = [
    ['', real('') ? modelName(real('')!) : 'Default'],
    ...['fable', 'opus', 'sonnet', 'haiku']
      .filter((a) => !real(a) || real(a)?.replace('[1m]', '') !== real('')?.replace('[1m]', ''))
      .map((a) => [a, real(a) ? modelName(real(a)!) : `${a[0].toUpperCase()}${a.slice(1)}`]),
  ];
  const usual = choices?.efforts[f.model] ?? null;
  const effortOptions = [['', usual ? effortName(usual) : 'Default'], ...Object.entries(EFFORTS).filter(([e]) => e !== usual)];
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
        <RepoPicker repos={sorted} repo={repo} pick={(id) => edit({ repoId: id, branch: f.existing ? defaultBranch(repos.find((r) => r.id === id)!) : '' })} />
        {f.existing ? (
          <BranchPicker branches={list} value={f.branch} pick={(b) => edit({ branch: b })} where={where} />
        ) : (
          <label className={styles.field} title="Names the worktree folder, and the branch unless you set one">
            <span className={styles.caption}>Name</span>
            <input value={f.name} onChange={(e) => edit({ name: e.currentTarget.value.replace(/\s+/g, '-') })} placeholder="fix-login-redirect" spellCheck={false} autoComplete="off" />
          </label>
        )}
        <fieldset className={styles.mode}>
          <legend>Where Claude runs</legend>
          <label><input type="radio" name="mode" checked={!f.existing} onChange={() => edit({ existing: false, branch: '' })} />New worktree</label>
          <label><input type="radio" name="mode" checked={f.existing} onChange={() => edit({ existing: true, branch: defaultBranch(repo) })} />Existing branch, no worktree</label>
        </fieldset>
        <button type="submit" className={styles.create} disabled={!valid || pending}>
          {pending ? 'Creating…' : 'Create'} <kbd>⌘↵</kbd>
        </button>
      </div>
      {!f.existing && (
        <div className={styles.options}>
          <label className={styles.input} title="The new branch; defaults to the name">
            <span>Branch</span>
            <input value={f.branch} onChange={(e) => edit({ branch: e.currentTarget.value.replace(/\s+/g, '-') })} placeholder={name || 'same as name'} spellCheck={false} />
          </label>
          <label className={styles.input} title="Where the worktree is created; defaults to the repository's worktree folder">
            <span>Worktree path</span>
            <input value={f.path} onChange={(e) => edit({ path: e.currentTarget.value })} placeholder={`${repo.worktreeRoot ?? repo.defaultWorktreeRoot}/${name || '<name>'}/${folder}`} spellCheck={false} />
          </label>
        </div>
      )}
      <div className={styles.foot}>
        <p className={styles.hint} data-hint>
          {f.existing ? (
            picked?.worktree ? <>Starts Claude in <code>{picked.worktree}</code>, where it is checked out.</>
              : <>Switches <code>{main?.path ?? repo.path}</code> to {branch ? <code>{branch}</code> : 'the branch'} and starts Claude there.</>
          ) : (
            <>Branches from <code>{repo.base}</code> and starts Claude there.{repo.setupCommand && <> Runs <code>{repo.setupCommand}</code> there first.</>}</>
          )}
        </p>
        <label className={styles.select} title="The model Claude starts with; the first is the one your Claude Code settings pick">
          <span className={styles.caption}>Model</span>
          <select value={f.model} onChange={(e) => edit({ model: e.currentTarget.value })}>
            {modelOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <Icon name="chevron-down" size={14} />
        </label>
        <label className={styles.select} title="How hard Claude thinks; the first is the one your Claude Code settings give that model">
          <span className={styles.caption}>Effort</span>
          <select value={f.effort} onChange={(e) => edit({ effort: e.currentTarget.value })}>
            {effortOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <Icon name="chevron-down" size={14} />
        </label>
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

export function NewTaskDialog({ repos }: { repos: RepoView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <dialog id={DIALOG} ref={dialog} closedby="any" aria-label="New task" className={styles.dialog} onCancel={keepUnderLayer}>
      {repos.length > 0 && <NewTaskForm repos={repos} done={() => dialog.current?.close()} />}
    </dialog>
  );
}
