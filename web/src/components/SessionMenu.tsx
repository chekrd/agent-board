import { sessionAction } from '../api.ts';
import type { Session } from '../types.ts';
import styles from './SessionMenu.module.css';

export function SessionMenu({ session }: { session: Session }) {
  const id = `menu-${session.id}`;
  const act = (action: string, body?: unknown) => () => {
    document.getElementById(id)?.hidePopover();
    sessionAction(session.id, action, body).catch(reportError);
  };
  const exited = session.status === 'exited';

  return (
    <>
      <button popoverTarget={id} data-variant="ghost" aria-label="Session actions">⋯</button>
      <div id={id} popover="auto" className={styles.menu}>
        <button onClick={act('focus')}>{exited ? 'Continue in Ghostty' : 'Focus in Ghostty'}</button>
        {!exited && <button onClick={act('quit')}>Quit Claude</button>}
        <button onClick={act('archive', { archived: !session.archived })}>{session.archived ? 'Unarchive' : 'Archive'}</button>
        {exited && <button onClick={act('forget')} data-variant="danger">Remove from list</button>}
      </div>
    </>
  );
}
