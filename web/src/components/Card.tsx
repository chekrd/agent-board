import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { decisionKey } from '../../../server/decision.ts';
import { acceptance, choose, dismissal, freeze, kindOf, menuAnswer, primary as primaryOf, type Composer as Note, type Intent } from '../deck.ts';
import type { Action, Card as Keys } from '../keys.ts';
import type { Request } from '../outbox.ts';
import { queue, useQueue } from '../queue.ts';
import { openSheet } from '../router.ts';
import { hold } from '../sends.ts';
import type { MenuAnswer, RepoView, Session } from '../types.ts';
import { useFront } from '../useKeys.ts';
import { adviceFor, attentionOf, decisionOf, locate, sessionLabel } from '../util.ts';
import styles from './Card.module.css';
import { editDraft, readyPaths, uploading, useDraft } from './Composer.tsx';
import { DecisionBody } from './DecisionBody.tsx';
import { Icon } from './Icon.tsx';
import { MenuBody } from './MenuBody.tsx';
import { Age } from './Parts.tsx';
import { PromptBody } from './PromptBody.tsx';
import { archive, openTerminal, SessionMenu } from './SessionMenu.tsx';
import { StateMark } from './StateMark.tsx';
import { STATE_LABELS } from './Status.tsx';
import { TurnBody } from './TurnBody.tsx';
import { elaborate, explanationFor } from './WhyPanel.tsx';

// State that belongs to one decision: a new decision on the same card starts it afresh.
function useKeyed<T>(key: string | null, initial: () => T): [T, (value: T) => void] {
  const [state, setState] = useState(() => ({ key, value: initial() }));
  const current = state.key === key ? state : { key, value: initial() };
  if (current !== state) setState(current);
  return [current.value, (value: T) => setState({ key, value })];
}

// The guard as the card draws it, redrawn when it ends.
function useGuarded(until: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const left = until - Date.now();
    if (left <= 0) {
      setNow(Date.now());
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), left + 1);
    return () => clearTimeout(timer);
  }, [until]);
  return now < until;
}

export interface CardProps {
  session: Session;
  repos: RepoView[];
  // How many cards wait, for the footer's own Previous and Skip in a narrow window.
  deck: number;
  // Drawn after the reader saw another card, so it comes in rather than being there at once.
  enter: boolean;
}

const NOTE_MS = 5000;

const metaChip = (text: string, title?: string) => <span className={styles.chip} title={title}>{text}</span>;

export function Card({ session, repos, deck, enter }: CardProps) {
  const q = useQueue();
  const article = useRef<HTMLElement>(null);
  const why = useRef<HTMLElement>(null);
  const { worktree, branch } = locate(repos, session);
  const name = sessionLabel(session, branch);
  const kind = kindOf(session) ?? 'idle';
  const attention = attentionOf(session);
  const key = decisionKey(session);
  const decision = kind === 'ask' || kind === 'turn' ? decisionOf(session) : null;
  const menu = kind === 'menu' ? session.menu : null;
  // The compiler reads what a callback uses during render, so a `menu!.questions` there would throw on other cards.
  const options = decision?.options ?? [];
  const questions = menu?.questions ?? [];
  const advice = adviceFor(session);
  const done = advice?.state === 'done' ? advice : null;
  const frozen = key ? (q.frozen.get(key) ?? freeze(session)) : null;
  const draft = useDraft(session.id);
  const filled = !!draft.text || draft.files.length > 0;
  const guarded = useGuarded(q.guardUntil);
  const notSent = q.notSent.get(session.id);

  const [composing, setComposing] = useState(() => (decision?.options.length === 0 && !done) || filled);
  const [focusAsk, setFocusAsk] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [hidden, setHidden] = useKeyed(key, () => false);
  const [whyOpen, setWhyOpen] = useKeyed(key, () => false);
  const [picks, showPicks] = useKeyed<MenuAnswer[]>(key, () =>
    (key && queue.picksOf(key)) || (frozen?.via === 'menu' ? frozen.picks.map((p) => ({ ...p, labels: [...p.labels] })) : []));
  const setPicks = (value: MenuAnswer[]) => {
    showPicks(value);
    if (key) queue.pick(key, value);
  };

  useEffect(() => {
    if (key && frozen) queue.freeze(key, frozen);
  }, [key, frozen]);

  // A draft that comes back, from a send taken back or refused, shows in the reply box.
  useEffect(() => {
    if (filled && decision) setComposing(true);
  }, [filled]);

  useEffect(() => {
    if (!note) return;
    const timer = setTimeout(() => setNote(null), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note]);

  // An outside change brings the card in; a deal runs its own transition.
  useLayoutEffect(() => {
    if (enter && !document.documentElement.dataset.deal) article.current!.dataset.enter = '';
  }, []);

  useEffect(() => {
    if (whyOpen) why.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [whyOpen]);

  const open = kind === 'idle' || (decision !== null && composing);
  const box: Note = { open: decision !== null && composing, text: draft.text, files: readyPaths(draft), uploading: uploading(draft) };
  const primary = primaryOf(session, frozen, { composer: box, picks: menu ? picks : undefined });

  const focusCard = () => article.current?.focus({ preventScroll: true });
  const compose = () => {
    setComposing(true);
    setFocusAsk((n) => n + 1);
  };
  const closeComposer = () => {
    setComposing(false);
    focusCard();
  };
  // A press holds its request for 5 s, and the card leaves with it: sideways for a dismissal, down otherwise. Focus
  // in a field the card takes along would be left on the page, so the card takes it first. A command answers
  // nothing, so its card stays.
  const send = (r: Request) => {
    if (r.command) {
      hold(session, r, name);
      if (decision) setNote(`${r.label.split(/\s/)[0]} goes to the terminal as typed; the question stays open.`);
      return;
    }
    if (article.current?.contains(document.activeElement)) focusCard();
    queue.own(session.id);
    queue.deal(r.action === 'dismiss' ? 'side' : 'down', () => void hold(session, r, name, { dealt: true }));
  };
  const press = (p: Request | Intent | null) => {
    if (!p) return;
    if (!('intent' in p)) send(p);
    else if (p.intent === 'terminal') openTerminal(session.id).catch(reportError);
    else compose();
  };
  const pressPrimary = () => {
    if (!primary.disabled && !queue.guarded()) press(primary.press);
  };
  const pick = (label: string) => {
    if (!queue.guarded()) send(choose(session, label, box));
  };
  const edit = () => {
    if (!done) return;
    const text = done.choice && !done.answer.startsWith(done.choice) ? `${done.choice}. ${done.answer}` : done.answer;
    editDraft(session.id, (d) => ({ ...d, text }));
    compose();
  };
  const toggleWhy = () => {
    if (!decision) return;
    if (!whyOpen) {
      const e = explanationFor(session, decision.key);
      if (!e || e.state === 'failed') elaborate(session, decision.key);
    }
    setWhyOpen(!whyOpen);
  };
  const toggleMenu = (question: number, label: string) => {
    const multi = questions[question]?.multiSelect;
    setPicks(picks.map((p, i) => {
      if (i !== question) return p;
      if (multi) return { ...p, labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] };
      return { labels: p.labels[0] === label ? [] : [label], other: '' };
    }));
  };
  const lone = questions.length === 1 && !questions[0].multiSelect;
  // A menu of one single-choice question answers with the pick, as the terminal does.
  const pickInMenu = (question: number, label: string) => {
    if (!lone) return toggleMenu(question, label);
    if (queue.guarded()) return;
    const only = [{ labels: [label], other: '' }];
    setPicks(only);
    send(menuAnswer(session, only));
  };
  const dismiss = () => {
    if (!queue.guarded()) send(dismissal(session));
  };
  const accept = () => {
    const r = acceptance(session);
    if (r && !queue.guarded()) send(r);
  };
  const archiveIt = () => archive(session, name);

  const keys: Keys = {
    kind,
    options: options.length,
    questions: questions.map((x) => x.options.length),
    lone,
    suggestion: !!done && decision !== null,
    primary: !primary.disabled && primary.press !== null,
    why: whyOpen,
    composing: decision !== null && composing,
  };
  const act = (a: Action) => {
    if (a.type === 'option') pick(options[a.index].label);
    else if (a.type === 'pick') pickInMenu(a.question, questions[a.question].options[a.option].label);
    else if (a.type === 'primary') pressPrimary();
    else if (a.type === 'skip') queue.skip();
    else if (a.type === 'previous') queue.previous();
    else if (a.type === 'details') setHidden(!hidden);
    else if (a.type === 'compose') compose();
    else if (a.type === 'edit') edit();
    else if (a.type === 'elaborate') toggleWhy();
    else if (a.type === 'open') openSheet(session.id, a.tab);
    else if (a.type === 'archive') archiveIt();
    else if (a.type === 'close' && a.what === 'why') setWhyOpen(false);
    else if (a.type === 'close') closeComposer();
  };
  useFront({ card: keys, act });

  const learnings = session.summary?.learnings ?? [];
  const rankReason = session.rankReason && (
    <em className={styles.reason} title="Why it sits here in the queue; a model ranks the open decisions">{session.rankReason}</em>
  );
  let meta: ReactNode;
  if (kind === 'ask') {
    meta = <><Age at={session.question?.askedAt ?? session.updatedAt} prefix="asked " />{metaChip(session.question?.category ?? '', 'The kind of question, as Claude classified it')}{rankReason}</>;
  } else if (kind === 'turn') {
    meta = <><Age at={session.summary?.at ?? session.updatedAt} prefix="asked " />{metaChip("from Claude's last message", "Claude ended its turn with a choice for you; a model read it from its last message")}{rankReason}</>;
  } else if (menu) {
    meta = <><Age at={menu.at} prefix="asked " />{metaChip('asked in the terminal', 'Claude opened a choice menu in its terminal; answering here picks the options there for you')}{rankReason}</>;
  } else if (kind === 'prompt') {
    meta = <><Age at={session.updatedAt} />{session.tty && <code className={styles.tty} title="The terminal device Claude runs on">{session.tty}</code>}</>;
  } else meta = <Age at={session.summary?.at ?? session.updatedAt} prefix="finished " />;

  const composer = {
    focus: focusAsk,
    note,
    onSend: send,
    onEscape: () => (decision ? closeComposer() : focusCard()),
  };

  return (
    <article
      ref={article}
      className={styles.card}
      data-card
      data-session={session.id}
      data-kind={kind}
      data-key={key ?? undefined}
      aria-label={`${name} · ${STATE_LABELS[attention]}`}
      tabIndex={-1}
    >
      <header className={styles.head}>
        <div className={styles.top}>
          <span className={styles.state} data-attention={attention}>
            <StateMark state={attention} />
            {STATE_LABELS[attention]}
          </span>
          {q.updated.has(session.id) && <span className={styles.updated} data-updated>Updated just now</span>}
          <span className={styles.name}>{name}</span>
          <span className={styles.spacer} />
          <nav className={styles.nav} aria-label="Open the task">
            <button type="button" onClick={() => openSheet(session.id, 'overview')}>Overview <kbd>O</kbd></button>
            <button type="button" onClick={() => openSheet(session.id, 'diff')}>Diff <kbd>D</kbd></button>
            {session.artifacts.length > 0 && (
              <button type="button" onClick={() => openSheet(session.id, 'artifacts')}>Artifacts {session.artifacts.length}</button>
            )}
            <span className={styles.more}><SessionMenu session={session} worktree={worktree} name={name} /></span>
          </nav>
        </div>
        <div className={styles.meta}>{meta}</div>
      </header>
      {notSent?.shown && <p className={styles.notSent} data-not-sent role="alert">Not sent: {notSent.message}</p>}
      {learnings.length > 0 && (
        <div className={styles.know} data-know>
          <span className={styles.knowLabel}>Worth knowing</span>
          {learnings.map((k) => <span key={k}>{k}</span>)}
        </div>
      )}
      {menu && session.summary?.text && <p className={styles.brief}>{session.summary.text}</p>}
      {decision && (
        <DecisionBody
          session={session}
          decision={decision}
          kind={kind as 'ask' | 'turn'}
          advice={advice}
          frozen={frozen}
          accepting={primary.press !== null && !('intent' in primary.press) && primary.press.action === 'accept-advice'}
          hidden={hidden}
          onDetails={() => setHidden(!hidden)}
          whyOpen={whyOpen}
          whyRef={why}
          onCloseWhy={() => setWhyOpen(false)}
          onPick={pick}
          onAccept={accept}
          onEdit={edit}
          composer={open ? composer : null}
        />
      )}
      {menu && (
        <MenuBody
          session={session}
          menu={menu}
          picks={picks}
          advice={advice}
          onPick={pickInMenu}
          onOther={(question, other) => setPicks(picks.map((p, i) => (i === question ? { labels: other ? [] : p.labels, other } : p)))}
          onPicks={setPicks}
          onSubmit={pressPrimary}
        />
      )}
      {kind === 'prompt' && <PromptBody session={session} />}
      {kind === 'idle' && <TurnBody session={session} composer={composer} />}
      <footer className={styles.foot}>
        <button
          type="button"
          className={styles.primary}
          data-primary
          data-guarded={guarded || undefined}
          disabled={primary.disabled}
          title={menu ? "Picks your answers in Claude's terminal menu" : undefined}
          onClick={pressPrimary}
        >
          <span className={styles.primaryLabel}>{primary.label}</span>
          <kbd>↵</kbd>
        </button>
        <span className={styles.steps}>
          <button type="button" aria-label="Previous card" disabled={deck < 2} onClick={() => queue.previous()}><Icon name="arrow-left" size={18} /></button>
          <button type="button" aria-label="Skip to the next card" disabled={deck < 2} onClick={() => queue.skip()}><Icon name="arrow-right" size={18} /></button>
        </span>
        <div className={styles.actions}>
          {decision && (
            <>
              <button type="button" className={styles.secondary} aria-pressed={composing} onClick={() => (composing ? closeComposer() : compose())}>
                Write my own <kbd>W</kbd>
              </button>
              <button type="button" className={styles.secondary} aria-pressed={whyOpen} title="A model reads the code and explains the background and each choice" onClick={toggleWhy}>
                Elaborate <kbd>Y</kbd>
              </button>
            </>
          )}
          {kind === 'idle' && (
            <button type="button" className={styles.secondary} onClick={archiveIt}>Archive <kbd>X</kbd></button>
          )}
          {kind === 'ask' && <button type="button" className={styles.dismiss} title="Clear the question without answering it" onClick={dismiss}>Dismiss</button>}
        </div>
      </footer>
    </article>
  );
}
