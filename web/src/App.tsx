import styles from './App.module.css';
import { Detail } from './components/Detail.tsx';
import { NewTaskDialog } from './components/NewTaskDialog.tsx';
import { Tile } from './components/Tile.tsx';
import { WorkspaceDialog } from './components/WorkspaceDialog.tsx';
import { orderTiles } from './order.ts';
import { useRoute } from './router.ts';
import { useStore } from './store.ts';

export function App() {
  const { repos, sessions, connected } = useStore();
  const route = useRoute();
  const { active, archived } = orderTiles(sessions);
  const selected = sessions.find((s) => s.id === route.sessionId);
  const asking = active.filter((s) => s.question).length;

  return (
    <div className={styles.app}>
      <aside className={styles.sidebar}>
        <header className={styles.header}>
          <h1>
            Agent IDE
            {asking > 0 && <span className={styles.count}>{asking}</span>}
          </h1>
          <span className={styles.connection} data-connected={connected} title={connected ? 'Connected' : 'Disconnected'} />
          <button commandfor="workspace" command="show-modal" data-variant="ghost">Repos</button>
          <button commandfor="new-task" command="show-modal" data-variant="primary" disabled={!repos.length}>New task</button>
        </header>
        <div className={styles.tiles}>
          {active.map((s) => (
            <Tile key={s.id} session={s} repos={repos} selected={s.id === route.sessionId} />
          ))}
          {!active.length && (
            <p className={styles.empty}>
              {repos.length ? 'No sessions yet. Start one with New task.' : 'Add a repository under Repos to begin.'}
            </p>
          )}
          {archived.length > 0 && (
            <details className={styles.archived}>
              <summary>Archived ({archived.length})</summary>
              {archived.map((s) => (
                <Tile key={s.id} session={s} repos={repos} selected={s.id === route.sessionId} />
              ))}
            </details>
          )}
        </div>
      </aside>
      <main className={styles.main}>
        {selected ? (
          <Detail key={selected.id} session={selected} sessions={sessions} repos={repos} tab={route.tab} />
        ) : (
          <div className={styles.placeholder}>Select a session</div>
        )}
      </main>
      <NewTaskDialog repos={repos} />
      <WorkspaceDialog repos={repos} sessions={sessions} />
    </div>
  );
}
