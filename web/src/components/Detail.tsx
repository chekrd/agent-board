import { sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, locate, sessionLabel } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import styles from './Detail.module.css';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { DiffStat, PrChip, StatusChip } from './Status.tsx';
import { FocusButton } from './Tile.tsx';

interface Props {
  session: Session;
  repos: RepoView[];
  tab: string;
}

export function Detail({ session, repos, tab }: Props) {
  const { repo, branch } = locate(repos, session);
  const tabs = [
    { key: 'details', label: session.question ? 'Question' : 'Details' },
    { key: 'diff', label: 'Diff' },
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;

  return (
    <div className={styles.detail}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2>{sessionLabel(session, branch)}</h2>
          <div className={styles.meta}>
            <span>{repo?.name} · {branch} · base {repo?.base}</span>
            <DiffStat stat={session.diffstat} />
            <StatusChip session={session} />
          </div>
        </div>
        <div className={styles.actions}>
          <FocusButton session={session} primary />
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
  const q = session.question;
  const live = session.status !== 'exited';
  return (
    <div className={styles.overview}>
      {session.summary && (
        <section className={styles.summary}>
          <h4>Summary <span>· updated {ago(session.summary.at)}</span></h4>
          <p>{session.summary.text}</p>
        </section>
      )}
      {q && (
        <section className={styles.question}>
          <div className={styles.questionMeta}>
            {session.rank && <strong>#{session.rank}</strong>} {q.category}
            {session.rankReason && <em> — {session.rankReason}</em>}
          </div>
          <h3>{q.title}</h3>
          <Markdown source={q.details} />
          <AnswerForm session={session} />
        </section>
      )}
      {session.lastMessage && (
        <section className={styles.lastMessage}>
          <h4>Claude's last message</h4>
          <Markdown source={session.lastMessage} />
        </section>
      )}
      {!q && live && (
        <section>
          <h4>Send to Claude</h4>
          <AnswerForm session={session} />
        </section>
      )}
      <dl className={styles.facts}>
        <dt>Task</dt>
        <dd>{session.firstPrompt ?? '—'}</dd>
        <dt>Worktree</dt>
        <dd><code>{session.worktree}</code></dd>
        {session.pr && (
          <>
            <dt>Pull request</dt>
            <dd><PrChip pr={session.pr} status={session.status} /> {session.pr.result && <code>{session.pr.result}</code>}</dd>
          </>
        )}
        <dt>Terminal</dt>
        <dd>{session.tty ? <code>{session.tty}</code> : '—'}</dd>
        <dt>Session</dt>
        <dd><code>{session.id}</code></dd>
      </dl>
    </div>
  );
}
