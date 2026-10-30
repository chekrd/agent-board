import { useEffect, useRef, useState } from 'react';
import { api, sessionAction } from '../api.ts';
import { queue } from '../queue.ts';
import { closeSheetOf } from '../router.ts';
import { patchSession, unpatch, useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { tilde } from '../util.ts';
import styles from './DeleteWorktreeDialog.module.css';

interface Loss {
  branch: string | null;
  deletesBranch: boolean;
  files: number;
  commits: number;
  // The task runs in the repository's main checkout, which clearing it keeps.
  checkout?: boolean;
  // Its worktree was removed already, outside the board.
  gone?: boolean;
  subtasks?: number;
  // A task across a folder of repos: what each of its worktrees would lose.
  repos?: { name: string; branch: string | null; deletesBranch: boolean; files: number; commits: number }[];
}

type Check = { state: 'checking' } | { state: 'done'; loss: Loss } | { state: 'failed'; error: string };

let ask: ((session: Session) => void) | null = null;

export const askDeleteWorktree = (session: Session) => ask?.(session);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DeleteWorktreeDialog() {
  const { home } = useStore();
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<{ session: Session; check: Check } | null>(null);

  useEffect(() => {
    ask = (session) => {
      setTarget({ session, check: { state: 'checking' } });
      const settle = (check: Check) => setTarget((t) => (t?.session === session ? { session, check } : t));
      api<Loss>('GET', `/api/sessions/${session.id}/delete-worktree`).then(
        (loss) => settle({ state: 'done', loss }),
        (err: Error) => settle({ state: 'failed', error: err.message }),
      );
    };
    return () => {
      ask = null;
    };
  }, []);

  // Once per ask: the loss check can settle after Esc has closed the dialog but before its close event clears the
  // target, and that must not open it again.
  const asked = target?.session;
  useEffect(() => {
    if (!asked || dialog.current!.open) return;
    dialog.current!.showModal();
    cancel.current?.focus();
  }, [asked]);

  // Claude quits first, so the session leaves the queue as ended, its card sideways when it is the one being read.
  const confirm = () => {
    const { session } = target!;
    dialog.current!.close();
    closeSheetOf(session.id);
    queue.leave(session.id, () => patchSession(session.id, { status: 'exited' }));
    sessionAction(session.id, 'delete-worktree').catch((err) => {
      unpatch(session.id);
      reportError(err);
    });
  };

  const check = target?.check;
  const loss = check?.state === 'done' ? check.loss : null;
  const keeps = !!loss?.checkout;
  const folder = loss?.repos;
  const lostIn = (l: { branch: string | null; deletesBranch: boolean; files: number; commits: number }) => [
    l.files && plural(l.files, 'uncommitted or untracked file', 'uncommitted or untracked files'),
    l.commits && `${plural(l.commits, 'unpushed commit', 'unpushed commits')}${l.branch && !l.deletesBranch ? `, which stay on ${l.branch}` : ''}`,
  ].filter((x) => !!x);
  const lost = folder
    ? folder.flatMap((r) => (lostIn(r).length ? [`${r.name}: ${lostIn(r).join(' and ')}`] : []))
    : loss
    ? lostIn(loss)
    : [];

  return (
    <dialog id="delete-worktree" ref={dialog} role="alertdialog" aria-labelledby="delete-worktree-title" className={styles.dialog} onClose={() => setTarget(null)}>
      {target && (
        <>
          <h2 id="delete-worktree-title">
            {folder ? `Clear the task and its task folder${folder.length ? `, with ${plural(folder.length, 'worktree', 'worktrees')}` : ''}?` : loss?.checkout ? 'Clear the task?' : loss?.deletesBranch ? `Clear the task, its worktree and its local branch ${loss.branch}?` : 'Clear the task and its worktree?'}
          </h2>
          <code className={styles.path}>{tilde(target.session.worktree, home)}</code>
          {check?.state === 'checking' && <p className={styles.muted}>Checking what would be lost…</p>}
          {check?.state === 'failed' && <p>Could not check what would be lost ({check.error}); uncommitted changes and unpushed commits may be lost.</p>}
          {folder && folder.length > 0 && (
            <p>
              Removes the worktree{folder.length > 1 ? 's' : ''} in {folder.map((r) => r.name).join(', ')}
              {folder.some((r) => r.deletesBranch) && <> and {folder.length > 1 ? 'their' : 'its'} local branch <code>{loss!.branch}</code></>}.
            </p>
          )}
          {loss?.gone ? (
            <p>{folder ? 'Its task folder is already gone.' : 'Its worktree is already gone.'}</p>
          ) : loss?.checkout ? (
            <p>The task runs in the repository's main checkout, which stays as it is{loss.branch ? `, on ${loss.branch}` : ''}.</p>
          ) : loss && (lost.length ? (
            <>
              <p className={styles.warning}>Not everything is pushed. This throws away:</p>
              <ul className={styles.loss}>{lost.map((l) => <li key={l}>{l}</li>)}</ul>
            </>
          ) : (
            <p>Nothing is lost: there are no uncommitted changes, and every commit is pushed.</p>
          ))}
          <p className={styles.muted}>
            {keeps ? "This task's Claude quits, its terminal closes and the task leaves the board." : folder ? "Claude quits, the task folder's terminals close and the task leaves the board." : "Claude quits, the worktree's terminals close and the task leaves the board."}
            {!!loss?.subtasks && ` ${loss.subtasks === 1 ? 'Its subtask goes' : `Its ${loss.subtasks} subtasks go`} with it, ${loss.subtasks === 1 ? 'its Claude' : 'their Claudes'} too.`}
          </p>
          <footer>
            <button type="button" ref={cancel} commandfor="delete-worktree" command="close">Cancel</button>
            <button type="button" className={styles.delete} disabled={check?.state === 'checking'} onClick={confirm}>Clear task</button>
          </footer>
        </>
      )}
    </dialog>
  );
}
