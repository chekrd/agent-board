import { useEffect, useState } from 'react';
import { useQueue } from '../queue.ts';
import type { Route } from '../router.ts';
import { useStore, type Link } from '../store.ts';
import type { Session } from '../types.ts';
import { Icon } from './Icon.tsx';
import { Meter } from './Meter.tsx';
import { openNewTask } from './NewTaskForm.tsx';
import styles from './TopBar.module.css';
import { openRepos } from './WorkspaceDialog.tsx';

const LINK_TEXT: Record<Link, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function ConnectionPill({ link }: { link: Link }) {
  const [lostAt, setLostAt] = useState(0);
  useEffect(() => setLostAt(link === 'reconnecting' ? Date.now() : 0), [link]);
  const title = link === 'reconnecting' && lostAt
    ? `Lost the connection to Agent Board at ${time(lostAt)}; what you see may be out of date. Answers you send wait and go out once it is back.`
    : undefined;
  return (
    <span className={styles.link} data-link={link} title={title}>
      <span className={styles.dot} aria-hidden />
      <span className={styles.linkText}>{LINK_TEXT[link]}</span>
    </span>
  );
}

export function TopBar({ route, deck }: { route: Route; deck: readonly Session[] }) {
  const { repos, link, newVersion } = useStore();
  const { front } = useQueue();
  const onQueue = route.view === 'queue';
  return (
    <header className={styles.bar}>
      <div className={styles.start}>
        <span className={styles.wordmark} data-wordmark>Agent Board</span>
        <ConnectionPill link={link} />
        {newVersion && link === 'live' && (
          <button type="button" className={styles.reload} data-new-version onClick={() => location.reload()}>
            New version · Reload
          </button>
        )}
      </div>
      <div className={styles.middle}>
        {deck.length > 0 && <Meter deck={deck} repos={repos} current={onQueue ? front : null} />}
      </div>
      <div className={styles.end}>
        <button type="button" className={styles.ghost} data-repos aria-label="Repos" onClick={openRepos}>
          <Icon name="folder" size={17} />
          <span className={styles.label}>Repos</span>
        </button>
        <nav className={styles.toggle} aria-label="View">
          <a href={deck.length ? '/' : undefined} aria-current={onQueue ? 'page' : undefined} aria-disabled={!deck.length || undefined} aria-label="Queue">
            <Icon name="queue" />
            <span className={styles.label}>Queue</span>
          </a>
          <a href="/wall" aria-current={onQueue ? undefined : 'page'} aria-label="Wall">
            <Icon name="wall" />
            <span className={styles.label}>Wall</span>
          </a>
        </nav>
        <button type="button" className={styles.newTask} disabled={!repos.length} aria-label="New task" onClick={() => openNewTask(route.view)}>
          <Icon name="plus" />
          <span className={styles.label}>New task</span>
        </button>
      </div>
    </header>
  );
}
