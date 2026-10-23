import { sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, locate, sessionLabel } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import { DiffStat, StatusChip } from './Status.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import styles from './Tile.module.css';

export function Tile({ session, repos, selected }: { session: Session; repos: RepoView[]; selected: boolean }) {
  const { repo, branch } = locate(repos, session);
  const q = session.question;

  return (
    <article
      className={styles.tile}
      data-asking={q ? true : undefined}
      data-selected={selected || undefined}
      data-status={session.status}
    >
      <header className={styles.head}>
        <a className={styles.name} href={sessionPath(session.id, q ? 'details' : 'terminal')}>
          {sessionLabel(session, branch)}
        </a>
        <SessionMenu session={session} />
      </header>
      <div className={styles.meta}>
        <span className={styles.where}>{repo?.name} · {branch}</span>
        <DiffStat stat={session.diffstat} />
        {!q && <StatusChip status={session.status} />}
      </div>
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
            <a href={sessionPath(session.id, 'terminal')}>Terminal</a>
            <a href={sessionPath(session.id, 'diff')}>Diff</a>
          </nav>
        </section>
      )}
    </article>
  );
}
