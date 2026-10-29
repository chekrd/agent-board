import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent } from 'react';
import { arrivals, kindOf, promptOf } from '../deck.ts';
import { arrange, queue, signature, useQueue } from '../queue.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session } from '../types.ts';
import { isEditable } from '../useKeys.ts';
import { diag } from '../diag.ts'; // DIAG(paste-loss)
import { attentionOf, decisionOf, locate, sessionLabel } from '../util.ts';
import { AgentsDock } from './AgentsDock.tsx';
import { Card } from './Card.tsx';
import { Icon } from './Icon.tsx';
import styles from './Queue.module.css';
import { BranchMark } from './Parts.tsx';
import { StateMark } from './StateMark.tsx';
import { labelOf, stoppedOnError } from './Status.tsx';

function peekText(s: Session) {
  const kind = kindOf(s);
  if (kind === 'menu') return s.menu?.questions.map((q) => q.question).join(' · ') ?? '';
  if (kind === 'ask' || kind === 'turn') return decisionOf(s)?.problem ?? '';
  if (kind === 'prompt') return promptOf(s).headline;
  return s.summary?.text ?? '';
}

// Another card, or another decision on it: what must not replace a field the reader is typing in.
const differs = (a: Session | null, b: Session | null) => a?.id !== b?.id || (!!a && !!b && signature(a, Date.now()) !== signature(b, Date.now()));

// The front card of the deck with the next two peeking out behind it, or an empty table when nothing waits. While the
// reader types in a field that a change would take away (the card's reply box), the change waits until focus leaves it.
export function Queue({ deck }: { deck: readonly Session[] }) {
  const { repos } = useStore();
  const q = useQueue();
  const region = useRef<HTMLDivElement>(null);
  const cardFocused = useRef(false);
  const pressing = useRef(false);
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
  // DIAG(paste-loss)
  useEffect(() => {
    diag('queue-shown', { id: shown?.id ?? null, live: live?.id ?? null, typing });
  }, [shown?.id]);
  useEffect(() => () => queue.show(null), []);

  // Focus inside a card that went lands on the page; the card that came takes it instead.
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (cardFocused.current && (!active || active === document.body)) region.current?.querySelector<HTMLElement>('[data-card]')?.focus({ preventScroll: true });
  }, [shown?.id]);

  // A press that ends the wait brings up the card that waited: a skip or previous in that press was aimed at the card
  // before it, so it does nothing.
  const type = (on: boolean) => {
    if (!on && typing && differs(shown, live) && pressing.current) queue.holdMoves(true);
    if (on !== typing) diag('queue-typing', { on, held: differs(shown, live) }); // DIAG(paste-loss)
    setTyping(on);
  };
  useEffect(() => {
    const down = () => {
      pressing.current = true;
    };
    // Once the press's click has run.
    const up = () => setTimeout(() => {
      pressing.current = false;
      queue.holdMoves(false);
    });
    addEventListener('pointerdown', down, true);
    addEventListener('pointerup', up, true);
    addEventListener('pointercancel', up, true);
    return () => {
      removeEventListener('pointerdown', down, true);
      removeEventListener('pointerup', up, true);
      removeEventListener('pointercancel', up, true);
    };
  }, []);

  const onFocus = (e: FocusEvent) => {
    type(isEditable(e.target));
    cardFocused.current = !!(e.target as Element).closest('[data-card]');
  };
  const onBlur = (e: FocusEvent) => {
    const to = e.relatedTarget as Element | null;
    // Focus went to the page, or the window lost it and the field gets it back with the window.
    if (!to) {
      if (document.hasFocus()) type(false);
      return;
    }
    const inside = !!region.current?.contains(to);
    type(inside && isEditable(to));
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
              <Peek
                key={peeking[i]}
                session={s}
                slot={i + 1}
                repos={repos}
                mark={q.notSent.get(s.id)?.shown === false ? 'not-sent' : arrived.has(s.id) ? 'new' : null}
                enter={!!first && !first.peeks.includes(peeking[i])}
              />
            ))}
            <Card key={shown.id} session={shown} repos={repos} deck={arranged.length} enter={!!first && shown.id !== first.card} />
          </div>
          <Side direction="next" disabled={arranged.length < 2} />
        </main>
      ) : (
        <Empty />
      )}
      <AgentsDock />
    </div>
  );
}

function Empty() {
  const { sessions, link } = useStore();
  const working = sessions.filter((s) => !s.archived && attentionOf(s) === 'working').length;
  return (
    <main className={styles.stage} data-empty>
      <div className={styles.empty}>
        <svg className={styles.emptyArt} viewBox="0 0 160 120" aria-hidden>
          <rect x="40" y="4" width="80" height="60" rx="11" />
          <rect x="24" y="28" width="112" height="82" rx="14" />
          <circle cx="80" cy="69" r="17" />
          <path d="M72 69l6 6 11-12" />
        </svg>
        <h1>{link === 'connecting' ? 'Connecting…' : 'Nothing needs you.'}</h1>
        {link !== 'connecting' && (
          <p>{working ? `${working} ${working === 1 ? 'agent is' : 'agents are'} at work; what they ask for comes here.` : 'No agent is working right now.'}</p>
        )}
        {link !== 'connecting' && <a href="/wall">See every agent on the Wall <kbd>V</kbd></a>}
      </div>
    </main>
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
        title={previous ? 'Previous card (←)' : 'Skip to the next card (→)'}
        disabled={disabled}
        onClick={() => (previous ? queue.previous() : queue.skip())}
      >
        <Icon name={previous ? 'arrow-left' : 'arrow-right'} size={22} />
      </button>
    </div>
  );
}

const MARKS = { 'not-sent': 'Not sent', new: 'Just in' } as const;

// A peek names the card's state, or that it just came in, or that its send failed and it waits to be read again.
function Peek({ session, slot, repos, mark, enter }: { session: Session; slot: number; repos: RepoView[]; mark: keyof typeof MARKS | null; enter: boolean }) {
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
        <BranchMark session={session} branch={locate(repos, session).branch} />
        <span className={styles.peekName}>{sessionLabel(session, locate(repos, session).branch)}</span>
        <span className={styles.peekText}>{peekText(session)}</span>
        <span className={styles.kind} data-attention={mark ?? attention} data-error={(!mark && stoppedOnError(session, attention)) || undefined}>{mark ? MARKS[mark] : labelOf(session, attention)}</span>
      </span>
    </button>
  );
}

// The queue follows the deck on every view, so what arrives is told apart from what was there at the first snapshot.
export function useDeckSync(deck: readonly Session[], live: boolean) {
  useEffect(() => {
    if (live) queue.sync(deck);
  }, [deck, live]);
}
