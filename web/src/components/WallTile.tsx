import type { MouseEvent } from 'react';
import { openDecision } from '../../../server/decision.ts';
import { promptOf } from '../deck.ts';
import { openSheet, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { useBusy } from '../sends.ts';
import { useStore } from '../store.ts';
import { adviceFor, ago, attentionOf, decisionOf, locate, sessionLabel, shownOf, type Attention, type Shown } from '../util.ts';
import { Clock } from './Clock.tsx';
import { ParentCrumb, SUBTASK_LABELS } from './Findings.tsx';
import { SessionMenu } from './SessionMenu.tsx';
import { BranchMark } from './Parts.tsx';
import { StateMark } from './StateMark.tsx';
import { PrChip, STATE_HINTS, STATE_LABELS } from './Status.tsx';
import styles from './WallTile.module.css';

function textOf(s: Session, attention: Attention) {
  if (attention === 'decide') return decisionOf(s)?.problem ?? s.menu!.questions.map((q) => q.question).join(' · ');
  if (attention === 'focus') return promptOf(s).headline;
  return s.summary?.text ?? s.firstPrompt ?? 'Starting…';
}

// A subtask in one of these states wants you, and its task's tile says so.
const WANTS: Shown[] = ['decide', 'focus', 'idle'];
const rank = (s: Shown) => (WANTS.includes(s) ? WANTS.indexOf(s) : WANTS.length);

function adviceTag(s: Session) {
  const a = adviceFor(s);
  if (a?.state === 'done') return `Second opinion · ${a.confidence}%`;
  return a?.state === 'thinking' ? 'Second opinion running' : null;
}

// The whole tile opens the task's page, also for one waiting in the queue, whose page leads to its card; through a
// click on the article rather than a link stretched over it, which would sit above every label and hide its tooltip.
export function WallTile({ session, repos }: { session: Session; repos: RepoView[] }) {
  const { repo, worktree, branch } = locate(repos, session);
  const name = sessionLabel(session, branch);
  const attention = attentionOf(session);
  const shown = shownOf(session, useBusy());
  const archived = session.archived;
  const label = archived ? 'Archived' : STATE_LABELS[shown];
  const working = !archived && attention === 'working';
  const asked = attention === 'decide' ? openDecision(session)?.askedAt : undefined;
  const tag = shown === 'decide' && !archived ? adviceTag(session) : null;
  const subtasks = useStore().sessions.filter((o) => o.parent?.id === session.id && !o.archived);
  const busy = useBusy();
  const wanting = subtasks.filter((o) => WANTS.includes(shownOf(o, busy))).sort((a, b) => WANTS.indexOf(shownOf(a, busy)) - WANTS.indexOf(shownOf(b, busy)));
  const rest = subtasks.length - wanting.length;
  const wants = wanting.length && !archived && WANTS.indexOf(shownOf(wanting[0], busy)) < rank(shown) ? shownOf(wanting[0], busy) : undefined;

  const show = () => openSheet(session.id);
  const open = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest('a, button, [popover]') || getSelection()?.toString()) return;
    show();
  };
  const follow = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    show();
  };

  return (
    <article
      className={styles.tile}
      data-tile
      data-session={session.id}
      data-attention={shown}
      data-archived={archived || undefined}
      data-wants={wants}
      aria-label={`${name}, ${label}`}
      onClick={open}
    >
      <header className={styles.head}>
        <StateMark state={archived ? 'archived' : shown} />
        <span className={styles.state} title={archived ? undefined : STATE_HINTS[shown]}>{label}</span>
        <span className={styles.age} data-age title={asked !== undefined ? undefined : session.summary ? 'When the status was last updated' : 'When the session last changed'}>
          {asked !== undefined ? `asked ${ago(asked)}` : ago(session.summary?.at ?? session.updatedAt)}
        </span>
        <span className={styles.menu}>
          <SessionMenu session={session} worktree={worktree} name={name} />
        </span>
      </header>
      <ParentCrumb session={session} />
      <BranchMark session={session} branch={branch} />
      <a className={styles.name} href={sessionPath(session.id)} onClick={follow}>{name}</a>
      <p className={styles.text}>{textOf(session, attention)}</p>
      {subtasks.length > 0 && !archived && (
        <div className={styles.subtasks} data-subtasks aria-label="Subtasks">
          {wanting.map((o) => {
            const state = shownOf(o, busy);
            return (
              <button key={o.id} type="button" data-subtask={o.id} data-attention={state} title={`${sessionLabel(o, branch)}; opens the subtask`} onClick={() => openSheet(o.id)}>
                <StateMark state={state} size={8} />
                <span>{SUBTASK_LABELS[o.parent!.kind]} #{o.parent!.finding + 1}</span>
                <span className={styles.subtaskState}>{STATE_LABELS[state]}</span>
              </button>
            );
          })}
          {rest > 0 && <span className={styles.subtaskRest}>{wanting.length ? `+${rest} more` : `${rest} ${rest === 1 ? 'subtask' : 'subtasks'}`}</span>}
        </div>
      )}
      {working && (
        <div className={styles.work}>
          <code>{session.activity?.step ?? 'Starting'}</code>
          {session.activity && <span className={styles.clock} title="How long the turn has run"><Clock since={session.activity.since} /></span>}
        </div>
      )}
      {!archived && (
        <footer className={styles.foot}>
          <span className={styles.where}>{repo?.name} · {branch}</span>
          {tag && <span className={styles.tag}>{tag}</span>}
          {!!session.summary?.learnings?.length && <span className={styles.know} title="Claude found something notable; open the task to read it">Worth knowing</span>}
          <PrChip pr={session.pr} status={session.status} />
        </footer>
      )}
    </article>
  );
}
