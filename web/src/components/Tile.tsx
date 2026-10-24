import type { MouseEvent } from 'react';
import { sessionAction } from '../api.ts';
import { go, sessionPath } from '../router.ts';
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

  // The whole tile opens the task, but not through a link stretched over it: that would sit
  // above every label and hide their hover explanations.
  const open = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, [popover]') || getSelection()?.toString()) return;
    go(sessionPath(session.id));
  };

  return (
    <article className={styles.tile} data-tile data-attention={attentionOf(session)} onClick={open}>
      <header className={styles.head}>
        <AttentionChip session={session} />
        {!!session.summary?.learnings?.length && (
          <span className={styles.learned} title="Claude found something notable; open the task to read it">Worth knowing</span>
        )}
        <span className={styles.age} title={q ? 'When Claude asked' : session.summary ? 'When the status was last updated' : 'When the session started'}>{ago(q?.askedAt ?? session.summary?.at ?? session.createdAt)}</span>
        <SessionMenu session={session} worktree={worktree} />
      </header>
      <a className={styles.name} href={sessionPath(session.id)}>{sessionLabel(session, branch)}</a>
      <span className={styles.where}>{repo?.name} · {branch}</span>
      {session.menu ? (
        <p className={styles.problem}>{session.menu.questions.map((m) => m.question).join(' · ')}</p>
      ) : decision ? (
        <p className={styles.problem}>{decision.problem}</p>
      ) : session.status === 'waiting' ? (
        <p className={styles.problem}>Claude is showing {session.waitingFor ?? 'a prompt'} in its terminal</p>
      ) : (
        headline && <p className={styles.headline}>{headline}</p>
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
      title={exited ? 'Continue this conversation' : 'Show its terminal in Ghostty'}
      onClick={() => sessionAction(session.id, 'focus').catch(reportError)}
    >
      {exited ? 'Continue' : 'Terminal'}
    </button>
  );
}
