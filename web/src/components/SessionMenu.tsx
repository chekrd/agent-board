import { sessionAction } from '../api.ts';
import type { Session, WorktreeView } from '../types.ts';
import styles from './SessionMenu.module.css';

export function SessionMenu({ session, worktree }: { session: Session; worktree: WorktreeView | undefined }) {
  const id = `menu-${session.id}`;
  const act = (action: string, body?: unknown) => () => {
    document.getElementById(id)?.hidePopover();
    sessionAction(session.id, action, body).catch(reportError);
  };
  const exited = session.status === 'exited';
  const deleteWorktree = () => {
    const what = worktree?.branch ? `the worktree and its local branch ${worktree.branch}` : 'the worktree';
    if (!confirm(`Delete ${what}?\n\n${session.worktree}\n\nClaude quits and the worktree's Ghostty tabs close. Uncommitted changes and unpushed commits are lost.`)) return;
    act('delete-worktree')();
  };

  return (
    <>
      <button popoverTarget={id} data-variant="ghost" aria-label="Session actions" title="More actions">⋯</button>
      <div id={id} popover="auto" className={styles.menu}>
        <button onClick={act('focus')} title={exited ? 'Continue this conversation in a new Ghostty tab' : 'Switch to its Ghostty tab'}>{exited ? 'Continue' : 'Terminal'}</button>
        {!exited && <button onClick={act('quit')} title="Stop the Claude process; the conversation can be continued later">Quit Claude</button>}
        <button onClick={act('archive', { archived: !session.archived })}>{session.archived ? 'Unarchive' : 'Archive'}</button>
        {exited && <button onClick={act('forget')} data-variant="danger" title="Drop the tile; the conversation and worktree stay">Remove from list</button>}
        {worktree && !worktree.isMain && <button onClick={deleteWorktree} data-variant="danger" title="Quit Claude and delete the worktree and its local branch">Delete worktree…</button>}
      </div>
    </>
  );
}
