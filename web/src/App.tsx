import { useEffect } from 'react';
import { DeleteWorktreeDialog } from './components/DeleteWorktreeDialog.tsx';
import { KeysDialog } from './components/KeysDialog.tsx';
import { NewTaskDialog } from './components/NewTaskForm.tsx';
import { Queue, useDeckSync } from './components/Queue.tsx';
import { RestartBanner } from './components/RestartBanner.tsx';
import { TaskSheet } from './components/TaskSheet.tsx';
import { Toasts } from './components/Toasts.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Wall } from './components/Wall.tsx';
import { WorkspaceDialog } from './components/WorkspaceDialog.tsx';
import { deckOf } from './deck.ts';
import { useRoute } from './router.ts';
import { useBusy } from './sends.ts';
import { useStore } from './store.ts';
import { useBoardKeys } from './useKeys.ts';
import { setBoard } from './ux.ts';

export function App() {
  const store = useStore();
  const route = useRoute();
  const deck = deckOf(store.sessions, useBusy());
  const sheetSession = route.sheet && store.sessions.find((s) => s.id === route.sheet!.id);

  useEffect(() => {
    document.documentElement.dataset.view = route.view;
  }, [route.view]);

  useEffect(() => {
    const live = store.sessions.filter((s) => !s.archived);
    setBoard({ tasks: live.length, deck: deck.length, names: store.sessions.flatMap((s) => [s.title, s.worktree.split('/').at(-1)]).filter((n): n is string => !!n) });
  }, [store.sessions, deck.length]);

  useDeckSync(deck, store.link !== 'connecting');
  useBoardKeys({ route, deck: deck.length, repos: store.repos.length > 0, artifacts: !!sheetSession?.artifacts.length });

  return (
    <>
      <TopBar route={route} deck={deck} />
      <RestartBanner />
      {/* Under an open task the view stays, so it comes back as it was left. */}
      <div className="views">
        <div className="view" data-covered={!!route.sheet || undefined} inert={!!route.sheet}>
          {route.view === 'queue' ? <Queue deck={deck} /> : <Wall deck={deck} />}
        </div>
        <TaskSheet route={route} />
      </div>
      <NewTaskDialog repos={store.repos} />
      <WorkspaceDialog roots={store.roots} repos={store.repos} sessions={store.sessions} />
      <KeysDialog />
      <DeleteWorktreeDialog />
      <Toasts />
    </>
  );
}
