import { useActionState, useRef, useState } from 'react';
import { api } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView } from '../types.ts';
import styles from './Dialog.module.css';

export function NewTaskDialog({ repos }: { repos: RepoView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [name, setName] = useState('');
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];

  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const result = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', {
        repoId: repo.id,
        name: form.get('name'),
        branch: form.get('branch'),
        path: form.get('path'),
        prompt: form.get('prompt'),
        startClaude: form.get('startClaude') === 'on',
      });
      dialog.current?.close();
      setName('');
      if (result.sessionId) go(sessionPath(result.sessionId));
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);

  return (
    <dialog id="new-task" ref={dialog} closedby="any" className={styles.dialog}>
      {repo && (
        <form action={submit} className={styles.form}>
          <h2>New task</h2>
          <label>
            Repository
            <select value={repo.id} onChange={(e) => setRepoId(Number(e.target.value))}>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>{r.name} — {r.path}</option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input name="name" required autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="fix-login-redirect" pattern="[A-Za-z0-9._\/\-]+" />
          </label>
          <div className={styles.row}>
            <label>
              Branch
              <input name="branch" placeholder={name || 'same as name'} />
            </label>
            <label>
              Worktree path
              <input name="path" placeholder={`${repo.defaultWorktreeRoot}/${name || '<name>'}/${repo.path.split('/').at(-1)}`} />
            </label>
          </div>
          <label>
            Prompt for Claude
            <textarea name="prompt" rows={6} placeholder="What should Claude work on? Leave empty to start an idle session." />
          </label>
          <label className={styles.check}>
            <input type="checkbox" name="startClaude" defaultChecked /> Start a Claude session
          </label>
          <p className={styles.hint}>
            Branches from <code>{repo.base}</code> and opens a Ghostty tab.{repo.setupCommand && <> Runs <code>{repo.setupCommand}</code> there first.</>}
          </p>
          {error && <p className={styles.error}>{error}</p>}
          <footer>
            <button type="button" commandfor="new-task" command="close">Cancel</button>
            <button type="submit" data-variant="primary" disabled={pending}>{pending ? 'Creating…' : 'Create'}</button>
          </footer>
        </form>
      )}
    </dialog>
  );
}
