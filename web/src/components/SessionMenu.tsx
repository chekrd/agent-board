import { api, sessionAction } from '../api.ts';
import type { Session, WorktreeView } from '../types.ts';
import styles from './SessionMenu.module.css';

export function SessionMenu({ session, worktree }: { session: Session; worktree: WorktreeView | undefined }) {
  const id = `menu-${session.id}`;
  const act = (action: string, body?: unknown) => () => {
    document.getElementById(id)?.hidePopover();
    sessionAction(session.id, action, body).catch(reportError);
  };
  const exited = session.status === 'exited';
  const deleteWorktree = async () => {
    document.getElementById(id)?.hidePopover();
    const loss = await api<Loss>('GET', `/api/sessions/${session.id}/delete-worktree`).catch((err: Error) => err);
    if (!confirm(deleteMessage(session.worktree, loss))) return;
    act('delete-worktree')();
  };

  return (
    <>
      <button popoverTarget={id} data-variant="ghost" aria-label="Session actions" title="More actions">⋯</button>
      <div id={id} popover="auto" className={styles.menu}>
        <button onClick={act('focus')} title={exited ? 'Continue this conversation in a new Ghostty tab' : 'Switch to its Ghostty tab'}>{exited ? 'Continue' : 'Terminal'}</button>
        <button onClick={act('finder')} title={session.worktree}>Open in Finder</button>
        <button onClick={act('vscode')} title={session.worktree}>Open in VS Code</button>
        {!exited && <button onClick={act('quit')} title="Stop the Claude process; the conversation can be continued later">Quit Claude</button>}
        <button onClick={act('archive', { archived: !session.archived })}>{session.archived ? 'Unarchive' : 'Archive'}</button>
        {exited && <button onClick={act('forget')} data-variant="danger" title="Drop the tile; the conversation and worktree stay">Remove from list</button>}
        {worktree && !worktree.isMain && <button onClick={deleteWorktree} data-variant="danger" title="Quit Claude and delete the worktree and its local branch">Delete worktree…</button>}
      </div>
    </>
  );
}

interface Loss {
  branch: string | null;
  deletesBranch: boolean;
  files: number;
  commits: number;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function deleteMessage(path: string, loss: Loss | Error) {
  const tail = "Claude quits and the worktree's Ghostty tabs close.";
  if (loss instanceof Error) return `Delete the worktree?\n\n${path}\n\nCould not check what would be lost (${loss.message}); uncommitted changes and unpushed commits may be lost.\n\n${tail}`;
  const what = loss.deletesBranch ? `the worktree and its local branch ${loss.branch}` : 'the worktree';
  const lost = [
    loss.files && plural(loss.files, 'uncommitted or untracked file', 'uncommitted or untracked files'),
    loss.commits && `${plural(loss.commits, 'commit', 'commits')} that no other branch or remote has`,
  ].filter(Boolean);
  const verdict = lost.length
    ? `This throws away:\n${lost.map((l) => `• ${l}`).join('\n')}`
    : 'Nothing is lost: there are no uncommitted changes, and every commit is on a remote or another branch.';
  return `Delete ${what}?\n\n${path}\n\n${verdict}\n\n${tail}`;
}
