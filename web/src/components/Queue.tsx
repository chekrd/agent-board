import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { arrivals, kindOf, promptOf } from '../deck.ts';
import type { Request } from '../outbox.ts';
import { arrange, queue, signature, useQueue } from '../queue.ts';
import { openSheet } from '../router.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session } from '../types.ts';
import { isEditable } from '../useKeys.ts';
import { attentionOf, decisionOf, locate, sessionLabel } from '../util.ts';
import { Card } from './Card.tsx';
import { Icon } from './Icon.tsx';
import styles from './Queue.module.css';
import { StateMark } from './StateMark.tsx';
import { STATE_LABELS } from './Status.tsx';
import { toast } from './Toasts.tsx';
import { Wall } from './Wall.tsx';

function peekText(s: Session) {
  const kind = kindOf(s);
  if (kind === 'menu') return s.menu?.questions.map((q) => q.question).join(' · ') ?? '';
  if (kind === 'ask' || kind === 'turn') return decisionOf(s)?.problem ?? '';
  if (kind === 'prompt') return promptOf(s).headline;
  return s.summary?.text ?? '';
}

// Another card, or another decision on it: what must not replace a field the reader is typing in.
const differs = (a: Session | null, b: Session | null) => a?.id !== b?.id || (!!a && !!b && signature(a, Date.now()) !== signature(b, Date.now()));

// Answering from the card comes with the held sends; until then a press opens the task, where answering is.
const send = (session: Session, _request: Request) => openSheet(session.id, 'overview');

// The front card of the deck with the next two peeking out behind it, or the Wall when nothing waits. While the reader
// types in a field that a change would take away (the card's reply box, or New task on the resting Wall), the
// change waits until focus leaves it.
export function Queue({ deck }: { deck: readonly Session[] }) {
  const { repos } = useStore();
  const q = useQueue();
  const region = useRef<HTMLDivElement>(null);
  const cardFocused = useRef(false);
  const [typing, setTyping] = useState(false);
  const arranged = arrange(deck, q);
  const live = arranged[0] ?? null;
  const [shown, setShown] = useState(live);
  const next = typing && differs(shown, live) ? shown : live;
  if (next !== shown) setShown(next);
  const rest = arranged.filter((s) => s.id !== shown?.id);
  const peeking = rest.slice(0, 2).map((s, i) => `${i}:${s.id}`);
  // What the queue drew first after it opened is simply there; what comes later moves in.
  const [first, setFirst] = useState<{ card: string; peeks: string[] } | null>(null);
  if (!first && shown) setFirst({ card: shown.id, peeks: peeking });

  useEffect(() => {
    queue.show(shown);
  }, [shown]);
  useEffect(() => () => queue.show(null), []);

  // Focus inside a card that went lands on the page; the card that came takes it instead.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (cardFocused.current && (!active || active === document.body)) region.current?.querySelector<HTMLElement>('[data-card]')?.focus({ preventScroll: true });
  }, [shown?.id]);

  const onFocus = (e: FocusEvent) => {
    setTyping(isEditable(e.target));
    cardFocused.current = !!(e.target as Element).closest('[data-card]');
  };
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    // The window lost focus, and the field gets it back with the window.
    if (!to) return void (document.hasFocus() && setTyping(false));
    const inside = !!region.current?.contains(to);
    setTyping(inside && isEditable(to));
    cardFocused.current = inside && !!to.closest('[data-card]');
  };

  const arrived = new Set(q.seen ? arrivals(deck, q.seen, q.shown).map((s) => s.id) : []);
  return (
    <div ref={region} className={styles.region} onFocus={onFocus} onBlur={onBlur}>
      {shown ? (
        <main className={styles.stage}>
          <Side direction="previous" disabled={arranged.length < 2} />
          <div className={styles.deck}>
            {arranged.length > 3 && <div className={styles.sliver} data-sliver aria-hidden />}
            {rest.slice(0, 2).map((s, i) => (
              <Peek key={peeking[i]} session={s} slot={i + 1} repos={repos} arrived={arrived.has(s.id)} enter={!!first && !first.peeks.includes(peeking[i])} />
            ))}
            <Card key={shown.id} session={shown} repos={repos} deck={arranged.length} enter={!!first && shown.id !== first.card} send={send} />
          </div>
          <Side direction="next" disabled={arranged.length < 2} />
        </main>
      ) : (
        <Wall deck={deck} />
      )}
    </div>
  );
}

function Side({ direction, disabled }: { direction: 'previous' | 'next'; disabled: boolean }) {
  const previous = direction === 'previous';
  return (
    <div className={styles.side}>
      <button
        type="button"
        className={styles.round}
        aria-label={previous ? 'Previous card' : 'Skip to the next card'}
        disabled={disabled}
        onClick={() => (previous ? queue.previous() : queue.skip())}
      >
        <Icon name={previous ? 'arrow-left' : 'arrow-right'} size={22} />
      </button>
      <span className={styles.caption}>{previous ? 'Previous' : 'Skip'} <kbd>{previous ? '←' : '→'}</kbd></span>
    </div>
  );
}

function Peek({ session, slot, repos, arrived, enter }: { session: Session; slot: number; repos: RepoView[]; arrived: boolean; enter: boolean }) {
  const attention = attentionOf(session);
  return (
    <button
      type="button"
      className={styles.peek}
      data-peek={slot}
      data-session={session.id}
      data-enter={enter || undefined}
      onClick={() => queue.jump(session.id)}
    >
      <span className={styles.row}>
        <StateMark state={attention} size={8} />
        <span className={styles.peekName}>{sessionLabel(session, locate(repos, session).branch)}</span>
        <span className={styles.peekText}>{peekText(session)}</span>
        <span className={styles.kind} data-attention={arrived ? 'new' : attention}>{arrived ? 'Just in' : STATE_LABELS[attention]}</span>
      </span>
    </button>
  );
}

// The queue follows the deck on every view, so what arrives is told apart from what was there at the first snapshot.
// On the queue, the card being read that stops waiting for a reason outside this page is named in a toast.
export function useDeckSync(deck: readonly Session[], { live, onQueue, sessions, repos }: { live: boolean; onQueue: boolean; sessions: readonly Session[]; repos: RepoView[] }) {
  const names = useRef(new Map<string, string>());
  useEffect(() => {
    if (!live) return;
    const named = new Map(sessions.map((s) => [s.id, sessionLabel(s, locate(repos, s).branch)]));
    for (const { id } of queue.sync(deck)) {
      if (onQueue) toast('info', `${named.get(id) ?? names.current.get(id) ?? 'A task'} no longer waits`, { session: id });
    }
    names.current = named;
  }, [deck, live, onQueue, sessions, repos]);
}
