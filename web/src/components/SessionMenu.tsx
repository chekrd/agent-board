import { useId } from 'react';
import { sessionAction } from '../api.ts';
import { closeSheetOf } from '../router.ts';
import { sends } from '../sends.ts';
import type { Session, WorktreeView } from '../types.ts';
import { askDeleteWorktree } from './DeleteWorktreeDialog.tsx';
import { Icon } from './Icon.tsx';
import styles from './SessionMenu.module.css';
import { toast } from './Toasts.tsx';

// A held answer would otherwise be pasted into the terminal while someone types in it.
export function openTerminal(id: string) {
  sends.sendNow(id);
  return sessionAction(id, 'focus');
}

export function archive(session: Session, name: string) {
  sessionAction(session.id, 'archive', { archived: true }).then(() => {
    const undo = () => void sessionAction(session.id, 'archive', { archived: false }).catch(reportError);
    toast('undo', `Archived ${name}`, { session: session.id, action: { label: 'Undo', run: undo } });
  }, reportError);
}

export function SessionMenu({ session, worktree, name }: { session: Session; worktree: WorktreeView | undefined; name: string }) {
  const id = useId();
  const exited = session.status === 'exited';
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
        <Item label="Open in Finder" note={session.worktree} onClick={act('finder')} />
        <Item label="Open in VS Code" note={session.worktree} onClick={act('vscode')} />
        {!exited && <Item label="Quit Claude" note="Stops the process; Continue picks it up later" onClick={act('quit')} />}
        {session.archived ? (
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
        {worktree && !worktree.isMain && (
          <Item label="Delete worktree…" note="Quits Claude, deletes the worktree and its branch" danger onClick={pick(() => askDeleteWorktree(session))} />
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
