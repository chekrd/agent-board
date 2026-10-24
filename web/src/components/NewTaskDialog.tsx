import { useActionState, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView } from '../types.ts';
import styles from './Dialog.module.css';

const EMPTY = { name: '', branch: '', path: '', prompt: '', startClaude: true, existingBranch: false };

interface Branch {
  name: string;
  worktree: string | null;
}

export function NewTaskDialog({ repos }: { repos: RepoView[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [repoId, setRepoId] = useState<number | null>(null);
  const [fields, setFields] = useState(EMPTY);
  const name = fields.name;
  // Controlled, because React resets a form action's uncontrolled fields even when it fails.
  const bind = (key: 'name' | 'branch' | 'path' | 'prompt') => ({
    name: key,
    value: fields[key],
    onChange: (e: { currentTarget: { value: string } }) => setFields({ ...fields, [key]: e.currentTarget.value }),
  });
  const repo = repos.find((r) => r.id === repoId) ?? repos[0];
  const [branches, setBranches] = useState<Branch[]>([]);
  const existing = fields.existingBranch;
  useEffect(() => {
    if (!existing || !repo) return;
    let current = true;
    api<Branch[]>('GET', `/api/repos/${repo.id}/branches`).then((b) => current && setBranches(b), () => current && setBranches([]));
    return () => {
      current = false;
    };
  }, [existing, repo?.id]);
  const picked = branches.find((b) => b.name === fields.branch.trim());
  const main = repo?.worktrees.find((w) => w.isMain);

  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const result = await api<{ path: string; sessionId: string | null }>('POST', '/api/worktrees', {
        repoId: repo.id,
        name: existing ? '' : form.get('name'),
        branch: form.get('branch'),
        path: form.get('path'),
        prompt: form.get('prompt'),
        startClaude: form.get('startClaude') === 'on',
        existingBranch: existing,
      });
      dialog.current?.close();
      setFields(EMPTY);
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
          <div className={styles.modes}>
            <label className={styles.check}>
              <input type="radio" name="mode" checked={!existing} onChange={() => setFields({ ...fields, existingBranch: false })} /> New worktree
            </label>
            <label className={styles.check}>
              <input type="radio" name="mode" checked={existing} onChange={() => setFields({ ...fields, existingBranch: true })} /> Existing branch, no worktree
            </label>
          </div>
          {existing ? (
            <label>
              Branch
              <input {...bind('branch')} required autoFocus list="new-task-branches" placeholder="Pick or type to filter" autoComplete="off" />
              <datalist id="new-task-branches">
                {branches.map((b) => (
                  <option key={b.name} value={b.name}>{b.worktree ?? ''}</option>
                ))}
              </datalist>
            </label>
          ) : (
            <>
              <label title="Names the worktree folder, and the branch unless you set one">
                Name
                <input {...bind('name')} required autoFocus placeholder="fix-login-redirect" pattern="[A-Za-z0-9._\/\-]+" />
              </label>
              <div className={styles.row}>
                <label title="The new branch; defaults to the name">
                  Branch
                  <input {...bind('branch')} placeholder={name || 'same as name'} />
                </label>
                <label title="Where the worktree is created; defaults to the repository's worktree folder">
                  Worktree path
                  <input {...bind('path')} placeholder={`${repo.defaultWorktreeRoot}/${name || '<name>'}/${repo.path.split('/').at(-1)}`} />
                </label>
              </div>
            </>
          )}
          <label>
            Prompt for Claude
            <textarea {...bind('prompt')} rows={6} placeholder="What should Claude work on? Leave empty to start an idle session." />
          </label>
          <label className={styles.check} title="Off: only the worktree and a shell tab are created">
            <input type="checkbox" name="startClaude" checked={fields.startClaude} onChange={(e) => setFields({ ...fields, startClaude: e.currentTarget.checked })} /> Start a Claude session
          </label>
          <p className={styles.hint}>
            {existing ? (
              picked?.worktree ? <>Starts Claude in <code>{picked.worktree}</code>, where it is checked out.</>
                : <>Switches <code>{main?.path ?? repo.path}</code> to {picked ? <code>{picked.name}</code> : 'the branch'} and starts Claude there.</>
            ) : (
              <>Branches from <code>{repo.base}</code> and starts Claude there.{repo.setupCommand && <> Runs <code>{repo.setupCommand}</code> there first.</>}</>
            )}
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
