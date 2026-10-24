import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sessionAction } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, decisionOf, locate, sessionLabel, type DecisionView } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import styles from './Detail.module.css';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { MenuCard } from './MenuCard.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { AttentionChip, PrChip } from './Status.tsx';
import { FocusButton } from './Tile.tsx';
import { Working } from './Working.tsx';

interface Props {
  session: Session;
  repos: RepoView[];
  tab: string;
}

export function Detail({ session, repos, tab }: Props) {
  const { worktree, branch } = locate(repos, session);
  const tabs = [
    { key: 'details', label: 'Overview' },
    { key: 'diff', label: 'Diff' },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.key === 'Escape' && !e.defaultPrevented && !target.closest('input, textarea, select, dialog, [popover]')) go('/');
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className={styles.detail}>
      <header className={styles.header}>
        <a className={styles.back} href="/" title="All tasks (Esc)">←</a>
        <div className={styles.heading}>
          <TaskName session={session} name={sessionLabel(session, branch)} />
          <div className={styles.meta}>
            <AttentionChip session={session} />
            <PrChip pr={session.pr} status={session.status} />
          </div>
        </div>
        <div className={styles.actions}>
          <FocusButton session={session} primary />
          <SessionMenu session={session} worktree={worktree} />
        </div>
      </header>
      <nav className={styles.tabs}>
        {tabs.map((t) => (
          <a key={t.key} href={sessionPath(session.id, t.key)} aria-current={t.key === current ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
      </nav>
      <div className={styles.body}>
        {current === 'details' && <Overview session={session} />}
        {current === 'diff' && <DiffView worktree={session.worktree} />}
      </div>
    </div>
  );
}

function TaskName({ session, name }: { session: Session; name: string }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (!editing) {
    return (
      <h2>
        <button type="button" className={styles.name} title="Click to rename; the Claude session gets the same name" onClick={() => setEditing(true)}>
          {name}
        </button>
      </h2>
    );
  }
  const save = (value: string) => {
    setEditing(false);
    if (cancelled.current || !value.trim() || value.trim() === name) return;
    sessionAction(session.id, 'rename', { title: value }).catch(reportError);
  };
  return (
    <input
      className={styles.nameInput}
      defaultValue={name}
      aria-label="Task name"
      title="Enter saves, Esc cancels"
      autoFocus
      onFocus={(e) => {
        cancelled.current = false;
        e.currentTarget.select();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}

function Overview({ session }: { session: Session }) {
  const decision = decisionOf(session);
  const summary = session.summary;
  return (
    <div className={styles.overview}>
      <Working session={session} large />
      {!!summary?.learnings?.length && (
        <section className={styles.know}>
          <h4 title="Something notable Claude found or learned; shown only when it is worth your attention">Worth knowing</h4>
          <ul>{summary.learnings.map((k) => <li key={k}>{k}</li>)}</ul>
        </section>
      )}
      {session.menu ? (
        <MenuCard key={session.menu.toolUseId} session={session} menu={session.menu} />
      ) : decision ? (
        <DecisionCard key={decision.key} session={session} decision={decision} />
      ) : session.status === 'waiting' ? (
        <section className={styles.blocked}>
          <p>Claude is showing <strong>{session.waitingFor ?? 'a prompt'}</strong> in its terminal. Answer it there.</p>
          <FocusButton session={session} primary />
        </section>
      ) : (
        session.status !== 'exited' && (
          <section>
            <h4>Message Claude</h4>
            <AnswerForm session={session} />
          </section>
        )
      )}
      <section className={styles.status}>
        <h4 title="A short summary of the session, rewritten by a model after each of Claude's messages">Status {summary && <span>· updated {ago(summary.at)}</span>}</h4>
        {summary ? (
          <>
            <p>{summary.text}</p>
            {!!summary.progress?.length && <ul>{summary.progress.map((k) => <li key={k}>{k}</li>)}</ul>}
          </>
        ) : (
          <p className={styles.pending}>No summary yet; it is written once Claude replies.</p>
        )}
      </section>
      {session.lastMessage && <LatestReply key={session.lastMessage} text={session.lastMessage} />}
      <section>
        <h4>Facts</h4>
        <dl className={styles.facts}>
          <dt>Task</dt>
          <dd>{session.firstPrompt ?? '—'}</dd>
          <dt>Worktree</dt>
          <dd><code>{session.worktree}</code></dd>
          {session.pr?.result && (
            <>
              <dt>Pull request</dt>
              <dd><code>{session.pr.result}</code></dd>
            </>
          )}
          <dt title="The terminal device Claude runs on">Terminal</dt>
          <dd title="The terminal device Claude runs on">{session.tty ? <code>{session.tty}</code> : '—'}</dd>
          <dt title="Claude Code's session id; claude --resume takes it">Session</dt>
          <dd title="Claude Code's session id; claude --resume takes it"><code>{session.id}</code></dd>
        </dl>
      </section>
    </div>
  );
}

function LatestReply({ text }: { text: string }) {
  const body = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState(false);
  const [full, setFull] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    setFolded(el.scrollHeight > el.clientHeight);
  }, []);
  return (
    <section className={styles.reply}>
      <h4>Claude's latest reply</h4>
      <div ref={body} className={styles.replyBody} data-folded={(folded && !full) || undefined} data-full={full || undefined}>
        <Markdown source={text} />
      </div>
      {folded && <button type="button" className={styles.more} data-variant="ghost" onClick={() => setFull(!full)}>{full ? 'Show less' : 'Show all'}</button>}
    </section>
  );
}

function DecisionCard({ session, decision }: { session: Session; decision: DecisionView }) {
  const q = session.question;
  const [open, setOpen] = useState(false);
  const explanation = session.explanation?.key === decision.key ? session.explanation : null;
  const request = () => sessionAction(session.id, 'elaborate').catch(reportError);
  const toggle = () => {
    if (!open && (!explanation || explanation.state === 'failed')) void request();
    setOpen(!open);
  };

  return (
    <section className={styles.decision}>
      <div className={styles.decisionMeta}>
        <strong title={q ? 'Claude asked you this and waits for the answer' : 'Claude ended its turn with a choice for you; a model read it from its last message'}>Decision</strong>
        {q && <span title="The kind of question, as Claude classified it">{q.category}</span>}
        {session.rank && <span title="Priority among the open decisions, ranked by a model">#{session.rank}</span>}
        {session.rankReason && <em>{session.rankReason}</em>}
        {q && <span className={styles.age}>asked {ago(q.askedAt)}</span>}
      </div>
      <h3>{decision.problem}</h3>
      {decision.brief && <p className={styles.brief}>{decision.brief}</p>}
      {decision.context && <div className={styles.context}><Markdown source={decision.context} /></div>}
      <button type="button" className={styles.elaborate} data-variant="ghost" aria-expanded={open} onClick={toggle} title={open ? undefined : 'A model reads the code and explains the background and each choice'}>
        {open ? 'Less' : 'Elaborate'}
      </button>
      {open && (
        <div className={styles.elaboration}>
          {!explanation || explanation.state === 'thinking' ? (
            <p className={styles.thinking}><span className={styles.spinner} aria-hidden /> Reading the code to explain this…</p>
          ) : explanation.state === 'failed' ? (
            <p className={styles.failed}>
              Could not explain: {explanation.error} <button type="button" data-variant="ghost" onClick={request}>Retry</button>
            </p>
          ) : (
            <Markdown source={explanation.text} />
          )}
        </div>
      )}
      <AnswerForm session={session} options={decision.options} />
    </section>
  );
}
