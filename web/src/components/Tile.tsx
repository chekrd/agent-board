import { sessionAction } from '../api.ts';
import { sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { ago, attentionOf, decisionOf, locate, sessionLabel } from '../util.ts';
import { AttentionChip, DiffStat, PrChip } from './Status.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import styles from './Tile.module.css';
import { Working } from './Working.tsx';

export function Tile({ session, repos }: { session: Session; repos: RepoView[] }) {
  const { repo, worktree, branch } = locate(repos, session);
  const decision = decisionOf(session);
  const q = session.question;
  const headline = session.summary?.text ?? (session.status === 'exited' ? null : session.lastMessage);

  return (
    <article className={styles.tile} data-tile data-attention={attentionOf(session)}>
      <header className={styles.head}>
        <AttentionChip session={session} />
        {q && <span className={styles.rank} title={`Priority among the open decisions, ranked by a model${session.rankReason ? `: ${session.rankReason}` : ''}`}>{session.rank ? `#${session.rank}` : '…'}</span>}
        {!!session.summary?.learnings?.length && (
          <span className={styles.learned} title="Claude found something notable; open the task to read it">Worth knowing</span>
        )}
        <span className={styles.age} title={q ? 'When Claude asked' : session.summary ? 'When the status was last updated' : 'When the session started'}>{ago(q?.askedAt ?? session.summary?.at ?? session.createdAt)}</span>
        <SessionMenu session={session} worktree={worktree} />
      </header>
      <a className={styles.name} href={sessionPath(session.id)} title="The task's name; opens the task">{sessionLabel(session, branch)}</a>
      <span className={styles.where}><span title="Repository">{repo?.name}</span> · <span title="Branch">{branch}</span></span>
      {session.menu ? (
        <p className={styles.problem} title="What Claude asks you in its terminal">{session.menu.questions.map((m) => m.question).join(' · ')}</p>
      ) : decision ? (
        <p className={styles.problem} title="What Claude needs you to decide">{decision.problem}</p>
      ) : session.status === 'waiting' ? (
        <p className={styles.problem} title="Answer it in the terminal">Claude is showing {session.waitingFor ?? 'a prompt'} in its terminal</p>
      ) : (
        headline && <p className={styles.headline} title={session.summary ? 'Where the task stands' : "Claude's last message"}>{headline}</p>
      )}
      <Working session={session} />
      <footer className={styles.foot}>
        <PrChip pr={session.pr} status={session.status} />
        <DiffStat stat={session.diffstat} />
      </footer>
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
