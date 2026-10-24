import { useActionState, useState } from 'react';
import { api, sessionAction } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { Conversation, RepoView, Session, WorktreeView } from '../types.ts';
import { ago } from '../util.ts';
import styles from './Dialog.module.css';

const closeDialog = () => document.querySelector<HTMLDialogElement>('#workspace')?.close();

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
    <dialog id="workspace" closedby="any" className={styles.dialog} style={{ width: 'min(960px, 94vw)' }}>
      <div className={styles.form}>
        <h2>Repositories &amp; worktrees</h2>
        <form action={addPath} className={styles.addRepo}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="A repository, or a folder to scan for repositories" required />
          <button type="button" onClick={pick}>Choose…</button>
          <button type="submit" data-variant="primary" disabled={adding}>{adding ? 'Scanning…' : 'Add'}</button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
        {roots.length > 0 && (
          <div className={styles.roots}>
            <span className={styles.hint}>Scanned folders:</span>
            {roots.map((root) => (
              <span key={root} className={styles.root}>
                <code>{root}</code>
                <button data-variant="ghost" title="Stop scanning this folder; repositories already found stay" onClick={() => api('DELETE', '/api/roots', { path: root })}>×</button>
              </span>
            ))}
            <button data-variant="ghost" onClick={() => api('POST', '/api/rescan')}>Rescan</button>
          </div>
        )}
        {repos.map((repo) => (
          <RepoSection key={repo.id} repo={repo} sessions={sessions} />
        ))}
        <footer>
          <button commandfor="workspace" command="close">Close</button>
        </footer>
      </div>
    </dialog>
  );
}

function RepoSection({ repo, sessions }: { repo: RepoView; sessions: Session[] }) {
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
      go(sessionPath(id));
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
    <section className={styles.section}>
      <div className={styles.repoHead}>
        <h3>{repo.name}</h3>
        <code>{repo.path}</code>
        <button data-variant="danger" onClick={() => run(() => api('DELETE', `/api/repos/${repo.id}`))} title="Hides it and drops its tiles; running Claudes, files and worktrees are left alone">
          Remove
        </button>
      </div>
      {repo.error && <p className={styles.error}>{repo.error}</p>}
      <ul className={styles.worktrees}>
        {repo.worktrees.map((w) => (
          <WorktreeRow
            key={w.path}
            worktree={w}
            sessions={sessions.filter((s) => s.worktree === w.path)}
            onStart={(continueId) => start(w.path, continueId)}
            onShell={() => run(() => api('POST', '/api/shell', { worktree: w.path }))}
            onRemove={w.isMain ? undefined : () => setRemoving(w.path)}
          />
        ))}
      </ul>
      {removing && (
        <form action={remove} className={styles.confirm}>
          <p>Remove worktree <code>{removing}</code>? Its sessions are stopped.</p>
          <label className={styles.check}><input type="checkbox" name="deleteBranch" /> Also delete the branch</label>
          <label className={styles.check}><input type="checkbox" name="force" /> Force (discard uncommitted changes)</label>
          <footer>
            <button type="button" onClick={() => setRemoving(null)}>Cancel</button>
            <button type="submit" data-variant="primary">Remove worktree</button>
          </footer>
        </form>
      )}
      <details className={styles.repoSettings}>
        <summary>Settings</summary>
        <form action={save} className={styles.settings}>
          <label>
            Base branch
            <input name="baseBranch" defaultValue={repo.baseBranch ?? ''} placeholder={`${repo.base} (detected)`} />
          </label>
          <label>
            Worktree folder
            <input name="worktreeRoot" defaultValue={repo.worktreeRoot ?? ''} placeholder={repo.defaultWorktreeRoot} />
          </label>
          <label>
            Setup command after create
            <input name="setupCommand" defaultValue={repo.setupCommand ?? ''} placeholder="e.g. pnpm install" />
          </label>
          <button type="submit">Save</button>
        </form>
      </details>
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}

type Start = (continueId?: string) => void;

function WorktreeRow({ worktree: w, sessions, onStart, onShell, onRemove }: { worktree: WorktreeView; sessions: Session[]; onStart: Start; onShell: () => void; onRemove?: () => void }) {
  const latest = w.conversations[0];
  return (
    <li className={styles.worktree}>
      <div className={styles.wtRow}>
        <span className={styles.wtName} title={w.path}>
          {w.branch ?? `detached ${w.head.slice(0, 8)}`} <small>{w.path}</small>
        </span>
        {latest && <ConversationAction conversation={latest} sessions={sessions} onStart={onStart} primary />}
        <button onClick={() => onStart()} title="New Claude session in a Ghostty tab">New Claude</button>
        <button onClick={onShell} title="Shell in a Ghostty tab">Shell</button>
        {onRemove && <button data-variant="danger" onClick={onRemove}>Remove</button>}
      </div>
      {w.conversations.length > 0 && (
        <details className={styles.conversations}>
          <summary>{w.conversations.length} conversation{w.conversations.length > 1 ? 's' : ''}{latest && <> · latest: {label(latest)}</>}</summary>
          <ul>
            {w.conversations.map((c) => (
              <li key={c.id}>
                <span className={styles.wtName} title={c.firstPrompt ?? ''}>{label(c)}</span>
                <small>{ago(c.updatedAt)}</small>
                <ConversationAction conversation={c} sessions={sessions} onStart={onStart} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

const label = (c: Conversation) => c.title ?? c.firstPrompt?.split('\n')[0] ?? c.id.slice(0, 8);

function ConversationAction({ conversation: c, sessions, onStart, primary = false }: { conversation: Conversation; sessions: Session[]; onStart: Start; primary?: boolean }) {
  const managed = sessions.find((s) => s.id === c.id);
  const variant = primary ? 'primary' : undefined;
  const hint = primary ? `: ${label(c)}` : '';
  if (managed && managed.status !== 'exited') {
    return (
      <button
        data-variant={variant}
        title={`Switch to its Ghostty tab${hint}`}
        onClick={() => { closeDialog(); go(sessionPath(c.id)); sessionAction(c.id, 'focus').catch(reportError); }}
      >
        Focus
      </button>
    );
  }
  if (c.livePid) {
    return <button data-variant={variant} disabled title={`Running (pid ${c.livePid}) outside a tracked Ghostty tab${hint}`}>Running</button>;
  }
  return (
    <button data-variant={variant} title={`Continue in a new Ghostty tab${hint}`} onClick={() => onStart(c.id)}>
      Continue
    </button>
  );
}
