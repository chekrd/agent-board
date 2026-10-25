import { useEffect, useRef, type FocusEvent } from 'react';
import { deckOf } from '../deck.ts';
import { answeredOf, confirmed, dockOf, lineOf, type Capsule } from '../dock.ts';
import { useNow } from '../now.ts';
import { queue, useQueue } from '../queue.ts';
import { openSheet } from '../router.ts';
import { HOLD_MS, sends, useSends } from '../sends.ts';
import { useStore } from '../store.ts';
import type { RepoView, Session } from '../types.ts';
import { attentionOf, locate, sessionLabel } from '../util.ts';
import styles from './AgentsDock.module.css';
import { Clock } from './Clock.tsx';
import { StateMark } from './StateMark.tsx';
import { PrChip, PrDot } from './Status.tsx';

const HOVER_MS = 150;
const narrow = matchMedia('(max-width: 760px)');

export function AgentsDock() {
  const { sessions, repos, link } = useStore();
  const items = useSends();
  const { fresh } = useQueue();
  const before = useRef(items);

  useEffect(() => {
    for (const id of confirmed(before.current, items)) queue.fresh(id);
    before.current = items;
  }, [items]);

  if (link === 'connecting') return null;
  const { capsules, working, ended } = dockOf(sessions, items);
  // With nothing in the deck the queue shows the Wall, which has every agent on it, as C does; a send on its way
  // keeps the dock up for its Undo.
  if (!deckOf(sessions, sends.busy()).length && !capsules.some((c) => c.send)) return null;
  const nameOf = (s: Session) => sessionLabel(s, locate(repos, s).branch);

  return (
    <footer className={styles.dock} data-dock aria-label="Agents not waiting on you">
      {working > 0 && <span className={styles.count}>{working} working</span>}
      {capsules.length > 0 ? (
        <div className={styles.capsules}>
          {capsules.map((c) => <CapsuleView key={c.session.id} capsule={c} repos={repos} fresh={fresh.has(c.session.id)} />)}
        </div>
      ) : (
        <p className={styles.empty}>No agent is working right now.</p>
      )}
      {ended.length > 0 && (
        <>
          <span className={styles.divider} aria-hidden />
          <a className={styles.ended} href="/wall" title={`Ended: ${ended.map(nameOf).join(', ')}. Open the Wall to see them.`}>
            <StateMark state="exited" />
            {ended.length} ended
          </a>
        </>
      )}
    </footer>
  );
}

function Line({ capsule }: { capsule: Capsule }) {
  return <>{lineOf(capsule, useNow(), HOLD_MS)}</>;
}

function CapsuleView({ capsule: c, repos, fresh }: { capsule: Capsule; repos: RepoView[]; fresh: boolean }) {
  const s = c.session;
  const { repo, branch } = locate(repos, s);
  const name = sessionLabel(s, branch);
  const card = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const glyph = <StateMark state={c.send ? attentionOf(s) : 'working'} />;
  const clock = !c.send && s.activity && <Clock since={s.activity.since} />;
  const know = s.summary?.learnings?.[0];
  const answered = answeredOf(c);
  const summary = s.summary?.text ?? s.firstPrompt;

  // Not over a dialog that opened while the hover delay ran.
  const show = () => {
    if (!narrow.matches && !document.querySelector('dialog:modal')) card.current?.showPopover();
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (card.current?.matches(':popover-open')) card.current.hidePopover();
  };
  // Focus from the keyboard shows the card; the focus a click gives, or that a dialog closed by a click hands back, does not.
  const focus = (e: FocusEvent<HTMLButtonElement>) => {
    if (e.currentTarget.matches(':focus-visible')) show();
  };

  return (
    <div
      className={styles.capsule}
      data-capsule
      data-session={s.id}
      data-state={c.state}
      data-fresh={fresh || undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === 'touch') return;
        clearTimeout(timer.current);
        timer.current = setTimeout(show, HOVER_MS);
      }}
      onPointerLeave={hide}
    >
      <button
        type="button"
        className={styles.open}
        onClick={() => {
          hide();
          openSheet(s.id);
        }}
        onFocus={focus}
        onBlur={hide}
      >
        {glyph}
        <span className={styles.text}>
          <span className={styles.head}>
            <strong className={styles.name}>{name}</strong>
            <PrDot pr={s.pr} status={s.status} />
            {know && <span className={styles.know} data-know aria-hidden />}
          </span>
          {c.send ? <span className={styles.line}><Line capsule={c} /></span> : <code className={styles.line}><Line capsule={c} /></code>}
        </span>
        {clock && <span className={styles.clock} data-clock>{clock}</span>}
      </button>
      {c.state === 'held' && (
        <button type="button" className={styles.undo} onClick={() => sends.undo(c.send!.id)}>
          Undo
        </button>
      )}
      {/* Inert, so the PR link in it is no stop for Tab: everything on the card is in the sheet a click opens. */}
      <div ref={card} popover="hint" inert className={styles.card} data-hovercard>
        <strong className={styles.title}>{name}</strong>
        <code className={styles.where}>{[repo?.name, branch].filter(Boolean).join(' · ')}</code>
        <span className={styles.row}>
          {glyph}
          <span className={styles.step}><Line capsule={c} /></span>
          {clock}
        </span>
        <PrChip pr={s.pr} status={s.status} />
        {know && <p className={styles.worth}>Worth knowing: {know}</p>}
        {answered && <p className={styles.answered}>{answered}</p>}
        {summary && <p className={styles.summary}>{summary}</p>}
      </div>
    </div>
  );
}
