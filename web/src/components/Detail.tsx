import { useEffect, useState } from 'react';
import { sessionAction } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, decisionOf, locate, sessionLabel, type DecisionView } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import styles from './Detail.module.css';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { AttentionChip, DiffStat, PrChip } from './Status.tsx';
import { FocusButton } from './Tile.tsx';

interface Props {
  session: Session;
  repos: RepoView[];
  tab: string;
}

export function Detail({ session, repos, tab }: Props) {
  const { repo, worktree, branch } = locate(repos, session);
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
          <h2>{sessionLabel(session, branch)}</h2>
          <div className={styles.meta}>
            <AttentionChip session={session} />
            <span>{repo?.name} · {branch} · base {repo?.base}</span>
            <PrChip pr={session.pr} status={session.status} />
            <DiffStat stat={session.diffstat} />
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

function Overview({ session }: { session: Session }) {
  const decision = decisionOf(session);
  const summary = session.summary;
  return (
    <div className={styles.overview}>
      <section className={styles.know}>
        <h4>What you should know {summary && <span>· updated {ago(summary.at)}</span>}</h4>
        {summary ? (
          <>
            <p className={styles.headline}>{summary.text}</p>
            {!!summary.know?.length && <ul>{summary.know.map((k) => <li key={k}>{k}</li>)}</ul>}
          </>
        ) : (
          <p className={styles.pending}>No briefing yet; it is written once Claude finishes a turn.</p>
        )}
      </section>
      {decision ? (
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
      <details className={styles.context}>
        <summary>Conversation and facts</summary>
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
          <dt>Terminal</dt>
          <dd>{session.tty ? <code>{session.tty}</code> : '—'}</dd>
          <dt>Session</dt>
          <dd><code>{session.id}</code></dd>
        </dl>
        {session.lastMessage && (
          <div className={styles.lastMessage}>
            <h4>Claude's last message</h4>
            <Markdown source={session.lastMessage} />
          </div>
        )}
      </details>
    </div>
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
        <strong>Decision</strong>
        {q && <span>{q.category}</span>}
        {session.rank && <span>#{session.rank}</span>}
        {session.rankReason && <em>{session.rankReason}</em>}
        {q && <span className={styles.age}>asked {ago(q.askedAt)} ago</span>}
      </div>
      <h3>{decision.problem}</h3>
      {decision.brief ? <p className={styles.brief}>{decision.brief}</p> : decision.details && <Markdown source={decision.details} />}
      <button type="button" className={styles.elaborate} data-variant="ghost" aria-expanded={open} onClick={toggle}>
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
          {decision.brief && decision.details && (
            <details className={styles.original}>
              <summary>Claude's own write-up</summary>
              <Markdown source={decision.details} />
            </details>
          )}
        </div>
      )}
      <AnswerForm session={session} options={decision.options} />
    </section>
  );
}
