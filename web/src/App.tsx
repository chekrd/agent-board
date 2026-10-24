import { useEffect } from 'react';
import styles from './App.module.css';
import { Detail } from './components/Detail.tsx';
import { NewTaskDialog } from './components/NewTaskDialog.tsx';
import { Toasts } from './components/Toasts.tsx';
import { Tile } from './components/Tile.tsx';
import { WorkspaceDialog } from './components/WorkspaceDialog.tsx';
import { orderTiles } from './order.ts';
import { useRoute } from './router.ts';
import { useStore } from './store.ts';
import { attentionOf } from './util.ts';

export function App() {
  const { roots, repos, sessions, connected } = useStore();
  const route = useRoute();
  const selected = sessions.find((s) => s.id === route.sessionId);
  const deciding = sessions.filter((s) => !s.archived && attentionOf(s) === 'decide').length;

  useEffect(() => {
    document.title = deciding ? `(${deciding}) Agent Board` : 'Agent Board';
  }, [deciding]);

  return (
    <div className={styles.app}>
      {route.sessionId ? (
        selected ? (
          <Detail key={selected.id} session={selected} repos={repos} tab={route.tab} item={route.item} />
        ) : (
          <div className={styles.placeholder}>
            {connected ? <>This task is gone. <a href="/">All tasks</a></> : 'Connecting…'}
          </div>
        )
      ) : (
        <Board />
      )}
      <NewTaskDialog repos={repos} />
      <WorkspaceDialog roots={roots} repos={repos} sessions={sessions} />
      <Toasts />
    </div>
  );
}

function Board() {
  const { repos, sessions, connected } = useStore();
  const { active, archived } = orderTiles(sessions);

  return (
    <>
      <header className={styles.header}>
        <h1>Agent Board</h1>
        <span className={styles.connection} data-connected={connected} title={connected ? 'Connected to Agent Board; the board updates live' : 'Disconnected from Agent Board; reconnecting'} />
        <button commandfor="workspace" command="show-modal" data-variant="ghost">Repos</button>
        <button commandfor="new-task" command="show-modal" data-variant="primary" disabled={!repos.length}>New task</button>
      </header>
      <main className={styles.board}>
        <div className={styles.tiles}>
          {active.map((s) => <Tile key={s.id} session={s} repos={repos} />)}
        </div>
        {!active.length && (
          <p className={styles.empty}>
            {repos.length ? 'No sessions yet. Start one with New task.' : 'Add a repository or a folder of repositories under Repos to begin.'}
          </p>
        )}
        {archived.length > 0 && (
          <details className={styles.archived}>
            <summary>Archived ({archived.length})</summary>
            <div className={styles.tiles}>
              {archived.map((s) => <Tile key={s.id} session={s} repos={repos} />)}
            </div>
          </details>
        )}
      </main>
    </>
  );
}
