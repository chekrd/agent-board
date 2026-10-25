import { useEffect } from 'react';
import { queue } from '../queue.ts';
import type { Session } from '../types.ts';
import { Wall } from './Wall.tsx';

export function Queue({ deck }: { deck: readonly Session[] }) {
  return <Wall deck={deck} />;
}

// The queue follows the deck on every view, so what arrives is told apart from what was there at the first snapshot.
export function useDeckSync(deck: readonly Session[], live: boolean) {
  useEffect(() => {
    if (live) queue.sync(deck);
  }, [deck, live]);
}
