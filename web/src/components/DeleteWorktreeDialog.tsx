import { useEffect, useRef, useState } from 'react';
import { api, sessionAction } from '../api.ts';
import { closeSheetOf } from '../router.ts';
import type { Session } from '../types.ts';
import styles from './DeleteWorktreeDialog.module.css';

interface Loss {
  branch: string | null;
  deletesBranch: boolean;
  files: number;
  commits: number;
}

type Check = { state: 'checking' } | { state: 'done'; loss: Loss } | { state: 'failed'; error: string };

let ask: ((session: Session) => void) | null = null;

export const askDeleteWorktree = (session: Session) => ask?.(session);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function DeleteWorktreeDialog() {
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

  const confirm = () => {
    const { session } = target!;
    dialog.current!.close();
    closeSheetOf(session.id);
    sessionAction(session.id, 'delete-worktree').catch(reportError);
  };

  const check = target?.check;
  const loss = check?.state === 'done' ? check.loss : null;
  const lost = loss
    ? [
      loss.files && plural(loss.files, 'uncommitted or untracked file', 'uncommitted or untracked files'),
      loss.commits && `${plural(loss.commits, 'commit', 'commits')} that no other branch or remote has`,
    ].filter((l) => !!l)
    : [];

  return (
    <dialog id="delete-worktree" ref={dialog} role="alertdialog" aria-labelledby="delete-worktree-title" className={styles.dialog} onClose={() => setTarget(null)}>
      {target && (
        <>
          <h2 id="delete-worktree-title">{loss?.deletesBranch ? `Delete the worktree and its local branch ${loss.branch}?` : 'Delete the worktree?'}</h2>
          <code className={styles.path}>{target.session.worktree}</code>
          {check?.state === 'checking' && <p className={styles.muted}>Checking what would be lost…</p>}
          {check?.state === 'failed' && <p>Could not check what would be lost ({check.error}); uncommitted changes and unpushed commits may be lost.</p>}
          {loss && (lost.length ? (
            <>
              <p>This throws away:</p>
              <ul className={styles.loss}>{lost.map((l) => <li key={l}>{l}</li>)}</ul>
            </>
          ) : (
            <p>Nothing is lost: there are no uncommitted changes, and every commit is on a remote or another branch.</p>
          ))}
          <p className={styles.muted}>Claude quits and the worktree's terminals close.</p>
          <footer>
            <button type="button" ref={cancel} commandfor="delete-worktree" command="close">Cancel</button>
            <button type="button" className={styles.delete} disabled={check?.state === 'checking'} onClick={confirm}>Delete worktree</button>
          </footer>
        </>
      )}
    </dialog>
  );
}
