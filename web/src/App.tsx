import { useEffect } from 'react';
import styles from './App.module.css';
import { AgentsDock } from './components/AgentsDock.tsx';
import { DeleteWorktreeDialog } from './components/DeleteWorktreeDialog.tsx';
import { KeysDialog } from './components/KeysDialog.tsx';
import { NewTaskDialog } from './components/NewTaskForm.tsx';
import { Queue, useDeckSync } from './components/Queue.tsx';
import { TaskSheet } from './components/TaskSheet.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Wall } from './components/Wall.tsx';
import { WorkspaceDialog } from './components/WorkspaceDialog.tsx';
import { deckOf } from './deck.ts';
import { useRoute } from './router.ts';
import { sends, useSends } from './sends.ts';
import { useStore } from './store.ts';
import { useBoardKeys } from './useKeys.ts';
import { attentionOf } from './util.ts';

export function App() {
  const store = useStore();
  const route = useRoute();
  useSends();
  const deck = deckOf(store.sessions, sends.busy());
  const deciding = deck.filter((s) => attentionOf(s) === 'decide').length;
  const sheetSession = route.sheet && store.sessions.find((s) => s.id === route.sheet!.id);

  useEffect(() => {
    document.title = deciding ? `(${deciding}) Agent Board` : 'Agent Board';
  }, [deciding]);

  useEffect(() => {
    document.documentElement.dataset.view = route.view;
  }, [route.view]);

  useDeckSync(deck, store.link !== 'connecting');
  useBoardKeys({ route, deck: deck.length, repos: store.repos.length > 0, artifacts: !!sheetSession?.artifacts.length });

  return (
    <div className={styles.app}>
      <TopBar route={route} deck={deck} />
      {route.view === 'queue' ? <Queue deck={deck} /> : <Wall deck={deck} />}
      {route.view === 'queue' && <AgentsDock />}
      <TaskSheet route={route} />
      <NewTaskDialog repos={store.repos} />
      <WorkspaceDialog roots={store.roots} repos={store.repos} sessions={store.sessions} />
      <KeysDialog />
      <DeleteWorktreeDialog />
      <Toasts />
    </div>
  );
}
