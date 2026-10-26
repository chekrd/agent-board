import { useEffect, useLayoutEffect, useRef } from 'react';
import { SHEET_DIALOG } from '../keys.ts';
import { closeSheet, openerOfTask, showTab, type Route, type Tab } from '../router.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session } from '../types.ts';
import { attentionOf, locate, sessionLabel } from '../util.ts';
import { Artifacts } from './Artifacts.tsx';
import { DiffView } from './DiffView.tsx';
import { Icon } from './Icon.tsx';
import { Overview } from './Overview.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { StateMark } from './StateMark.tsx';
import { PrChip, STATE_HINTS, STATE_LABELS } from './Status.tsx';
import { TaskName } from './TaskName.tsx';
import styles from './TaskSheet.module.css';
import { toast } from './Toasts.tsx';

// The task's own page follows the route: a task URL opens it over the whole view, and Esc, the back button or Back
// return to the view it was opened from.
export function TaskSheet({ route }: { route: Route }) {
  const { sessions, repos, link } = useStore();
  const page = useRef<HTMLElement>(null);
  const sheet = route.sheet;
  const session = sheet ? sessions.find((s) => s.id === sheet.id) : undefined;
  const name = session ? sessionLabel(session, locate(repos, session).branch) : 'Task';
  const id = sheet?.id;
  const gone = !!sheet && link !== 'connecting' && !session;

  // Opening, the page takes focus itself, as the start of what it holds, rather than ringing its first button.
  useEffect(() => {
    if (id) page.current?.focus({ preventScroll: true });
  }, [id]);

  // Closing, focus goes back to what opened it, such as the tile's name; the view under it is no longer inert by then.
  const open = !!id;
  useLayoutEffect(() => {
    if (!open) return;
    const opener = openerOfTask();
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  useEffect(() => {
    if (!gone) return;
    toast('info', 'That task is gone.');
    closeSheet();
  }, [gone]);

  if (!sheet) return null;
  return (
    <section id={SHEET_DIALOG} ref={page} tabIndex={-1} className={styles.page} aria-label={name}>
      {link === 'connecting' && <p className={styles.connecting}>Connecting…</p>}
      {session && <Body key={session.id} session={session} name={name} repos={repos} tab={sheet.tab} item={sheet.item} back={route.view} />}
    </section>
  );
}

interface BodyProps {
  session: Session;
  name: string;
  repos: RepoView[];
  tab: Tab;
  item: string | null;
  back: Route['view'];
}

function Body({ session, name, repos, tab, item, back }: BodyProps) {
  const { worktree } = locate(repos, session);
  const attention = attentionOf(session);
  const tabs: { key: Tab; label: string; kbd: string }[] = [
    { key: 'overview', label: 'Overview', kbd: '1' },
    { key: 'diff', label: 'Diff', kbd: '2' },
    ...(session.artifacts.length ? [{ key: 'artifacts' as const, label: `Artifacts (${session.artifacts.length})`, kbd: '3' }] : []),
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : 'overview';

  return (
    <>
      <header className={styles.head}>
        <button type="button" className={styles.close} aria-label={back === 'wall' ? 'Back to the Wall' : 'Back to the queue'} onClick={closeSheet}>
          <Icon name="arrow-left" size={18} />
          <span>{back === 'wall' ? 'Wall' : 'Queue'}</span>
          <kbd>Esc</kbd>
        </button>
        <div className={styles.heading}>
          <TaskName session={session} name={name} />
          <span className={styles.state} data-attention={session.archived ? 'archived' : attention} title={session.archived ? undefined : STATE_HINTS[attention]}>
            <StateMark state={session.archived ? 'archived' : attention} size={8} />
            {session.archived ? 'Archived' : STATE_LABELS[attention]}
          </span>
          <PrChip pr={session.pr} status={session.status} />
        </div>
        <SessionMenu session={session} worktree={worktree} name={name} />
      </header>
      <nav className={styles.tabs} role="tablist" aria-label="Task">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={t.key === current} onClick={() => showTab(t.key)}>
            {t.label} <kbd>{t.kbd}</kbd>
          </button>
        ))}
      </nav>
      <div className={styles.panel} role="tabpanel">
        {current === 'overview' && <Overview session={session} name={name} />}
        {current === 'diff' && <DiffView worktree={session.worktree} />}
        {current === 'artifacts' && <Artifacts session={session} item={item} />}
      </div>
    </>
  );
}
