import { sessionAction } from '../api.ts';
import { sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, locate, sessionLabel } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import { DiffStat, PrChip, StatusChip } from './Status.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import styles from './Tile.module.css';

export function Tile({ session, repos, selected }: { session: Session; repos: RepoView[]; selected: boolean }) {
  const { repo, branch } = locate(repos, session);
  const q = session.question;

  return (
    <article
      className={styles.tile}
      data-tile
      data-asking={q ? true : undefined}
      data-selected={selected || undefined}
      data-status={session.status}
    >
      <header className={styles.head}>
        <a className={styles.name} href={sessionPath(session.id)}>
          {sessionLabel(session, branch)}
        </a>
        <FocusButton session={session} />
        <SessionMenu session={session} />
      </header>
      <div className={styles.meta}>
        <span className={styles.where}>{repo?.name} · {branch}</span>
        <PrChip pr={session.pr} status={session.status} />
        <DiffStat stat={session.diffstat} />
        {!q && <StatusChip session={session} />}
      </div>
      {!q && session.status === 'idle' && session.lastMessage && <p className={styles.excerpt}>{session.lastMessage}</p>}
      {q && (
        <section className={styles.question}>
          <div className={styles.rank}>
            <span className={styles.badge}>{session.rank ? `#${session.rank}` : '…'}</span>
            <span className={styles.category}>{q.category}</span>
            <span className={styles.age}>{ago(q.askedAt)}</span>
          </div>
          <h3 className={styles.title}>{q.title}</h3>
          {session.rankReason && <p className={styles.reason}>{session.rankReason}</p>}
          <AnswerForm session={session} compact />
          <nav className={styles.links}>
            <a href={sessionPath(session.id, 'details')}>Details</a>
            <a href={sessionPath(session.id, 'diff')}>Diff</a>
          </nav>
        </section>
      )}
    </article>
  );
}

export function FocusButton({ session, primary = false }: { session: Session; primary?: boolean }) {
  const exited = session.status === 'exited';
  return (
    <button
      data-variant={primary ? 'primary' : 'ghost'}
      title={exited ? 'Continue this conversation in a new Ghostty tab' : 'Switch to its Ghostty tab'}
      onClick={() => sessionAction(session.id, 'focus').catch(reportError)}
    >
      {exited ? 'Continue' : 'Focus'}
    </button>
  );
}
