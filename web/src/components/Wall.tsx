import { meter } from '../deck.ts';
import { orderTiles } from '../order.ts';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { attentionOf } from '../util.ts';
import { Icon } from './Icon.tsx';
import { NewTaskInline } from './NewTaskForm.tsx';
import styles from './Wall.module.css';
import { WallTile } from './WallTile.tsx';

export function Wall({ deck }: { deck: readonly Session[] }) {
  const { repos, sessions, link } = useStore();
  if (link === 'connecting') {
    return (
      <main className={styles.wall}>
        <p className={styles.connecting}>Connecting…</p>
      </main>
    );
  }
  const { active, archived } = orderTiles(sessions);
  const working = active.filter((s) => attentionOf(s) === 'working').length;
  const title = !sessions.length ? (repos.length ? 'No sessions yet.' : 'No repositories yet.') : deck.length ? 'Every agent, in priority order' : 'Nothing needs you.';
  const sub = !sessions.length ? null
    : deck.length ? `${meter(deck, null).label} wait in the queue.`
    : working ? `${working} ${working === 1 ? 'agent is' : 'agents are'} at work.`
    : 'No agent is working right now.';

  return (
    <main className={styles.wall} data-resting={(!!sessions.length && !deck.length) || undefined}>
      {repos.length > 0 && <NewTaskInline repos={repos} accent={!deck.length} />}
      <header className={styles.head}>
        <div className={styles.titles}>
          <h1>{title}</h1>
          {sub && <p>{sub}</p>}
        </div>
        {deck.length > 0 && (
          <a className={styles.back} href="/">
            Back to the queue <kbd>Esc</kbd>
          </a>
        )}
      </header>
      {!active.length && (
        <div className={styles.empty}>
          <Icon name="queue" size={44} stroke={1.4} />
          <p>{repos.length ? 'Start one with New task.' : 'Add a repository or a folder of repositories under Repos to begin.'}</p>
        </div>
      )}
      <div className={styles.tiles}>
        {active.map((s) => <WallTile key={s.id} session={s} repos={repos} />)}
      </div>
      {archived.length > 0 && (
        <details className={styles.archived}>
          <summary><Icon name="chevron-right" size={14} />Archived ({archived.length})</summary>
          <div className={styles.tiles}>
            {archived.map((s) => <WallTile key={s.id} session={s} repos={repos} />)}
          </div>
        </details>
      )}
    </main>
  );
}
