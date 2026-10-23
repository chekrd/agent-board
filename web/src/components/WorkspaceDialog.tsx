import { useActionState, useState } from 'react';
import { api } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import styles from './Dialog.module.css';

export function WorkspaceDialog({ repos, sessions }: { repos: RepoView[]; sessions: Session[] }) {
  const [path, setPath] = useState('');
  const [error, addRepo, adding] = useActionState(async () => {
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
    <dialog id="workspace" closedby="any" className={styles.dialog} style={{ width: 'min(900px, 94vw)' }}>
      <div className={styles.form}>
        <h2>Repositories &amp; worktrees</h2>
        <form action={addRepo} className={styles.addRepo}>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/repository" required />
          <button type="button" onClick={pick}>Choose…</button>
          <button type="submit" data-variant="primary" disabled={adding}>Add repository</button>
        </form>
        {error && <p className={styles.error}>{error}</p>}
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

  const start = (worktree: string, kind: 'claude' | 'shell') =>
    run(async () => {
      const { id } = await api<{ id: string }>('POST', '/api/sessions', { repoId: repo.id, worktree, kind });
      document.querySelector<HTMLDialogElement>('#workspace')?.close();
      go(sessionPath(id, 'terminal'));
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
        <button data-variant="danger" onClick={() => run(() => api('DELETE', `/api/repos/${repo.id}`))} title="Stops its sessions; files and worktrees stay on disk">
          Remove repo
        </button>
      </div>
      {repo.error && <p className={styles.error}>{repo.error}</p>}
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
      <ul className={styles.worktrees}>
        {repo.worktrees.map((w) => {
          const count = sessions.filter((s) => s.worktree === w.path && s.kind === 'claude').length;
          return (
            <li key={w.path}>
              <span className={styles.wtName} title={w.path}>
                {w.branch ?? `detached ${w.head.slice(0, 8)}`} <small>{w.path}</small>
              </span>
              {count > 0 && <small>{count} session{count > 1 ? 's' : ''}</small>}
              <button onClick={() => start(w.path, 'claude')}>Claude</button>
              <button onClick={() => start(w.path, 'shell')}>Shell</button>
              {!w.isMain && <button data-variant="danger" onClick={() => setRemoving(w.path)}>Remove</button>}
            </li>
          );
        })}
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
      {error && <p className={styles.error}>{error}</p>}
    </section>
  );
}
