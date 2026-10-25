import { useActionState, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { openSheet } from '../router.ts';
import type { Conversation, RepoView, Session, WorktreeView } from '../types.ts';
import { ago } from '../util.ts';
import { Icon } from './Icon.tsx';
import { openTerminal } from './SessionMenu.tsx';
import sheet from './TaskSheet.module.css';
import styles from './WorkspaceDialog.module.css';

const closeDialog = () => document.querySelector<HTMLDialogElement>('#workspace')?.close();

export function openRepos() {
  const dialog = document.querySelector<HTMLDialogElement>('#workspace');
  dialog?.showModal();
  dialog?.focus();
}

export function WorkspaceDialog({ roots, repos, sessions }: { roots: string[]; repos: RepoView[]; sessions: Session[] }) {
  const [path, setPath] = useState('');
  const [error, addPath, adding] = useActionState(async () => {
    try {
      await api('POST', '/api/repos', { path });
      setPath('');
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);

  const pick = async () => {
    const result = await api<{ path: string }>('POST', '/api/pick-folder').catch(() => null);
    if (result?.path) setPath(result.path);
  };

  return (
    <dialog id="workspace" closedby="any" tabIndex={-1} aria-labelledby="workspace-title" className={sheet.sheet}>
      <span className={sheet.grabber} aria-hidden />
      <header className={styles.head}>
        <button type="button" className={sheet.close} aria-label="Close" commandfor="workspace" command="close">
          <Icon name="chevron-down" size={18} />
          <kbd>Esc</kbd>
        </button>
        <h2 id="workspace-title">Repositories &amp; worktrees</h2>
      </header>
      <div className={styles.scroll}>
        <div className={styles.content}>
          <form action={addPath} className={styles.add}>
            <input value={path} onChange={(e) => setPath(e.target.value)} aria-label="Repository or folder" placeholder="A repository, or a folder to scan for repositories" spellCheck={false} required />
            <button type="button" className={styles.secondary} onClick={pick}>Choose…</button>
            <button type="submit" className={styles.ink} disabled={adding || !path.trim()}>{adding ? 'Scanning…' : 'Add'}</button>
          </form>
          {error && <p className={styles.error}>{error}</p>}
          {roots.length > 0 && (
            <div className={styles.roots}>
              <span>Scanned folders:</span>
              {roots.map((root) => (
                <span key={root} className={styles.root}>
                  <code>{root}</code>
                  <button type="button" aria-label={`Stop scanning ${root}`} title="Stop scanning this folder; repositories already found stay" onClick={() => api('DELETE', '/api/roots', { path: root }).catch(reportError)}>
                    <Icon name="close" size={12} />
                  </button>
                </span>
              ))}
              <button type="button" className={styles.tiny} title="Search the scanned folders for repositories and worktrees again" onClick={() => api('POST', '/api/rescan').catch(reportError)}>Rescan</button>
            </div>
          )}
          {!repos.length && <p className={styles.none}>Add a repository or a folder of repositories to begin.</p>}
          {repos.map((repo) => (
            <RepoSection key={repo.id} repo={repo} sessions={sessions} />
          ))}
        </div>
      </div>
    </dialog>
  );
}

function RepoSection({ repo, sessions }: { repo: RepoView; sessions: Session[] }) {
  const [settings, setSettings] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (fn: () => Promise<unknown>) => fn().then(() => setError(null), (err) => setError(err.message));

  const save = async (form: FormData) => {
    await run(() => api('PATCH', `/api/repos/${repo.id}`, {
      baseBranch: form.get('baseBranch'),
      setupCommand: form.get('setupCommand'),
      worktreeRoot: form.get('worktreeRoot'),
    }));
  };

  const start = (worktree: string, continueId?: string) =>
    run(async () => {
      const { id } = await api<{ id: string }>('POST', '/api/sessions', { repoId: repo.id, worktree, continueId });
      closeDialog();
      openSheet(id);
    });

  const remove = (form: FormData) =>
    run(async () => {
      await api('DELETE', '/api/worktrees', {
        repoId: repo.id,
        path: removing,
        deleteBranch: form.get('deleteBranch') === 'on',
        force: form.get('force') === 'on',
      });
      setRemoving(null);
    });

  return (
    <section className={styles.repo}>
      <div className={styles.repoHead}>
        <h3>{repo.name}</h3>
        <code>{repo.path}</code>
        <button type="button" className={styles.tiny} aria-expanded={settings} onClick={() => setSettings(!settings)}>Settings</button>
        <button type="button" className={styles.tiny} data-danger onClick={() => run(() => api('DELETE', `/api/repos/${repo.id}`))} title="Hides it and drops its tiles; running Claudes, files and worktrees are left alone">
          Remove
        </button>
      </div>
      {settings && (
        <form action={save} className={styles.settings}>
          <label title="The branch new worktrees start from and diffs compare against">
            <span>Base branch</span>
            <input name="baseBranch" defaultValue={repo.baseBranch ?? ''} placeholder={`${repo.base} (detected)`} spellCheck={false} />
          </label>
          <label>
            <span>Worktree folder</span>
            <input name="worktreeRoot" defaultValue={repo.worktreeRoot ?? ''} placeholder={repo.defaultWorktreeRoot} spellCheck={false} />
          </label>
          <label title="Runs in each new worktree before Claude starts">
            <span>Setup command after create</span>
            <input name="setupCommand" defaultValue={repo.setupCommand ?? ''} placeholder="e.g. pnpm install" spellCheck={false} />
          </label>
          <button type="submit" className={styles.ink}>Save</button>
        </form>
      )}
      {repo.error && <p className={styles.error}>{repo.error}</p>}
      {repo.worktrees.map((w) => (
        <WorktreeRow
          key={w.path}
          worktree={w}
          sessions={sessions.filter((s) => s.worktree === w.path)}
          onStart={(continueId) => start(w.path, continueId)}
          onShell={() => run(() => api('POST', '/api/shell', { worktree: w.path }))}
          onRemove={w.isMain ? undefined : () => setRemoving(w.path)}
        >
          {removing === w.path && (
            <form action={remove} className={styles.confirm}>
              <p>Remove worktree <code>{removing}</code>? Its sessions are stopped.</p>
              <div className={styles.checks}>
                <label><input type="checkbox" name="deleteBranch" /> Also delete the branch</label>
                <label><input type="checkbox" name="force" /> Force (discard uncommitted changes)</label>
              </div>
              <footer>
                <button type="button" className={styles.tiny} onClick={() => setRemoving(null)}>Cancel</button>
                <button type="submit" className={styles.tiny} data-danger>Remove worktree</button>
              </footer>
            </form>
          )}
        </WorktreeRow>
      ))}
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}

type Start = (continueId?: string) => void;

interface RowProps {
  worktree: WorktreeView;
  sessions: Session[];
  onStart: Start;
  onShell: () => void;
  onRemove?: () => void;
  children: ReactNode;
}

function WorktreeRow({ worktree: w, sessions, onStart, onShell, onRemove, children }: RowProps) {
  const latest = w.conversations[0];
  return (
    <div className={styles.worktree} data-worktree={w.path}>
      <div className={styles.wtRow}>
        <span className={styles.wtName} title={w.path}>
          <strong>{w.branch ?? `detached ${w.head.slice(0, 8)}`}</strong>
          <code>{w.path}</code>
        </span>
        {latest && <ConversationAction conversation={latest} sessions={sessions} onStart={onStart} primary />}
        <button type="button" className={styles.tiny} onClick={() => onStart()} title="New Claude session">New Claude</button>
        <button type="button" className={styles.tiny} onClick={onShell} title="Shell in a Ghostty tab">Shell</button>
        {onRemove && <button type="button" className={styles.tiny} data-danger onClick={onRemove}>Remove</button>}
      </div>
      {w.conversations.length > 0 && (
        <details className={styles.conversations}>
          <summary>
            <Icon name="chevron-right" size={12} />
            {w.conversations.length} conversation{w.conversations.length > 1 ? 's' : ''}{latest && <> · latest: {label(latest)}</>}
          </summary>
          <ul>
            {w.conversations.map((c) => (
              <li key={c.id}>
                <span title={c.firstPrompt ?? ''}>{label(c)}</span>
                <small>{ago(c.updatedAt)}</small>
                <ConversationAction conversation={c} sessions={sessions} onStart={onStart} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {children}
    </div>
  );
}

const label = (c: Conversation) => c.title ?? c.firstPrompt?.split('\n')[0] ?? c.id.slice(0, 8);

function ConversationAction({ conversation: c, sessions, onStart, primary = false }: { conversation: Conversation; sessions: Session[]; onStart: Start; primary?: boolean }) {
  const managed = sessions.find((s) => s.id === c.id);
  const look = primary ? styles.inkSm : styles.tiny;
  const hint = primary ? `: ${label(c)}` : '';
  if (managed && managed.status !== 'exited') {
    return (
      <button
        type="button"
        className={look}
        title={`Show its terminal${hint}`}
        onClick={() => {
          closeDialog();
          openSheet(c.id);
          openTerminal(c.id).catch(reportError);
        }}
      >
        Terminal
      </button>
    );
  }
  if (c.livePid) {
    return <button type="button" className={styles.tiny} disabled title={`Running (pid ${c.livePid}) outside a hidden session or a Ghostty tab${hint}`}>Running</button>;
  }
  return (
    <button type="button" className={look} title={`Continue in a new Ghostty tab${hint}`} onClick={() => onStart(c.id)}>
      Continue
    </button>
  );
}
