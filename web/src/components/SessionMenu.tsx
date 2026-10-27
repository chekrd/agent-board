import { useId } from 'react';
import { sessionAction } from '../api.ts';
import { queue } from '../queue.ts';
import { closeSheetOf, moveSheetOf } from '../router.ts';
import { sends } from '../sends.ts';
import { patchSession, unpatch, useStore } from '../store.ts';
import type { Resolution, Session, WorktreeView } from '../types.ts';
import { tilde } from '../util.ts';
import { askDeleteWorktree } from './DeleteWorktreeDialog.tsx';
import { Icon } from './Icon.tsx';
import styles from './SessionMenu.module.css';
import { toast } from './Toasts.tsx';

const TYPED_MS = 2000;

// A held answer goes out first, and the terminal comes up once it is typed (or 2 s on), so it is never pasted into a
// terminal someone types in.
export async function openTerminal(id: string) {
  await Promise.race([sends.sendNow(id), new Promise((done) => setTimeout(done, TYPED_MS))]);
  return sessionAction(id, 'focus');
}

// The page shows the change before the server has it; when the request fails, the session shows as the server has it.
const failed = (id: string) => (err: unknown) => {
  unpatch(id);
  reportError(err);
};

// The session leaves the queue at once, its card sideways when it is the one being read, and Undo brings it back.
// Taking a card out of the queue from this page needs no word that it no longer waits.
export function archive(session: Session, name: string) {
  const { id } = session;
  const front = queue.leave(id, () => patchSession(id, { archived: true }));
  sessionAction(id, 'archive', { archived: true }).then(() => {
    const undo = () => {
      const back = () => {
        patchSession(id, { archived: false });
        return true;
      };
      if (front) queue.restore(id, back);
      else back();
      sessionAction(id, 'archive', { archived: false }).catch(failed(id));
    };
    toast('undo', `Archived ${name}`, { session: id, action: { label: 'Undo', run: undo } });
  }, failed(id));
}

// Solved and Dropped take the subtask out of the queue like Archive, and its page gives way to its task's; Undo opens it
// again.
export function resolveSubtask(session: Session, state: Resolution['state'] | null, name: string) {
  const { id } = session;
  if (state && session.parent) moveSheetOf(id, session.parent.id);
  const change = () => patchSession(id, { resolution: state ? { state, at: Date.now() } : null, archived: !!state });
  if (state) queue.leave(id, change);
  else change();
  sessionAction(id, 'resolve', { state }).then(() => {
    if (state) toast('undo', `${state === 'solved' ? 'Solved' : 'Dropped'} ${name}`, { session: id, action: { label: 'Undo', run: () => resolveSubtask(session, null, name) } });
  }, failed(id));
}

// Claude quits: the session leaves the queue as ended, its card sideways when it is the one being read.
function quit(session: Session) {
  queue.leave(session.id, () => patchSession(session.id, { status: 'exited' }));
  sessionAction(session.id, 'quit').catch(failed(session.id));
}

export function SessionMenu({ session, worktree, name }: { session: Session; worktree: WorktreeView | undefined; name: string }) {
  const id = useId();
  const exited = session.status === 'exited';
  const path = tilde(session.worktree, useStore().home);
  const pick = (run: () => unknown) => () => {
    document.getElementById(id)?.hidePopover();
    run();
  };
  const act = (action: string, body?: unknown) => pick(() => sessionAction(session.id, action, body).catch(reportError));

  return (
    <>
      <button type="button" className={styles.more} popoverTarget={id} aria-label="Session actions" title="More actions">
        <Icon name="more" size={18} />
      </button>
      <div id={id} popover="auto" className={styles.menu}>
        {exited ? (
          <Item label="Continue" note="Resume the conversation in a hidden terminal" onClick={act('focus')} />
        ) : (
          <Item label="Terminal" note="Show its terminal in Ghostty" onClick={pick(() => openTerminal(session.id).catch(reportError))} />
        )}
        <Item label="Open in Finder" note={path} onClick={act('finder')} />
        <Item label="Open in VS Code" note={path} onClick={act('vscode')} />
        {!exited && (
          <Item
            label="Quit Claude"
            note="Stops the process; Continue picks it up later"
            onClick={pick(() => quit(session))}
          />
        )}
        {session.parent ? (session.resolution ? (
          <Item label="Reopen" note={`Marked ${session.resolution.state}; back into the queue and its task's open count`} onClick={pick(() => resolveSubtask(session, null, name))} />
        ) : (
          <>
            <Item label="Mark solved" note="Done; it stops counting as open on its task" onClick={pick(() => resolveSubtask(session, 'solved', name))} />
            <Item label="Drop" note="Not going on with it; it stops counting as open on its task" onClick={pick(() => resolveSubtask(session, 'dropped', name))} />
          </>
        )) : session.archived ? (
          <Item label="Unarchive" note="Back into the queue and the strip" onClick={act('archive', { archived: false })} />
        ) : (
          <Item label="Archive" note="Hide it; ranking, advice and summaries stop" onClick={pick(() => archive(session, name))} />
        )}
        {exited && (
          <Item
            label="Remove from list"
            note="The conversation and worktree stay"
            danger
            onClick={pick(() => {
              closeSheetOf(session.id);
              sessionAction(session.id, 'forget').catch(reportError);
            })}
          />
        )}
        {!session.parent && (
          <Item
            label="Clear task…"
            note={!worktree ? 'Quits Claude and removes the task; its worktree is already gone' : worktree.isMain ? 'Quits Claude and removes the task; the checkout stays' : 'Quits Claude, deletes the worktree and its branch, removes the task'}
            danger
            onClick={pick(() => askDeleteWorktree(session))}
          />
        )}
      </div>
    </>
  );
}

function Item({ label, note, danger = false, onClick }: { label: string; note: string; danger?: boolean; onClick: () => void }) {
  return (
    <button type="button" className={styles.item} data-danger={danger || undefined} onClick={onClick}>
      <span className={styles.label}>{label}</span>
      <span className={styles.note}>{note}</span>
    </button>
  );
}

export function FocusButton({ session }: { session: Session }) {
  const exited = session.status === 'exited';
  const open = () => (exited ? sessionAction(session.id, 'focus') : openTerminal(session.id)).catch(reportError);
  return (
    <button type="button" data-variant="primary" title={exited ? 'Continue this conversation' : 'Show its terminal in Ghostty'} onClick={open}>
      {exited ? 'Continue' : 'Terminal'}
    </button>
  );
}
