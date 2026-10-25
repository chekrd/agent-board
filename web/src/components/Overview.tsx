import { showTab } from '../router.ts';
import type { Session } from '../types.ts';
import { ago, decisionOf } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import { Clock } from './Clock.tsx';
import { DecisionCard } from './Detail.tsx';
import { LatestReply } from './LatestReply.tsx';
import { MenuCard } from './MenuCard.tsx';
import styles from './Overview.module.css';
import { FocusButton } from './SessionMenu.tsx';

export function Overview({ session }: { session: Session }) {
  const { summary, activity } = session;
  const decision = decisionOf(session);
  const working = session.status === 'working';
  const learnings = summary?.learnings ?? [];
  const artifacts = session.artifacts.toReversed();
  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        <div className={styles.main}>
          {working && (
            <section className={styles.working}>
              <span className={styles.spinner} aria-hidden />
              <div className={styles.step}>
                <strong>Claude is working</strong>
                <code>{activity?.step ?? 'Starting'}</code>
              </div>
              {activity && <span className={styles.clock} title="Time since your last message"><Clock since={activity.since} /></span>}
            </section>
          )}
          {learnings.length > 0 && (
            <section className={styles.know}>
              <h3 className={styles.label} title="Something notable Claude found or learned; shown only when it is worth your attention">Worth knowing</h3>
              {learnings.map((k) => <p key={k}>{k}</p>)}
            </section>
          )}
          {session.menu ? (
            <MenuCard key={session.menu.toolUseId} session={session} menu={session.menu} />
          ) : decision ? (
            <DecisionCard key={decision.key} session={session} decision={decision} />
          ) : session.status === 'waiting' ? (
            <section className={styles.blocked}>
              <p>Claude is showing <strong>{session.waitingFor ?? 'a prompt'}</strong> in its terminal. Answer it there.</p>
              <FocusButton session={session} />
            </section>
          ) : (
            !session.archived && session.status !== 'exited' && (
              <section className={styles.message}>
                <h3 className={styles.label}>Message Claude</h3>
                <AnswerForm session={session} />
              </section>
            )
          )}
          <section className={styles.status}>
            <h3 className={styles.label} title="A short summary of the session, rewritten by a model after each of Claude's messages">
              Status {summary && <span>· updated {ago(summary.at)}</span>}
            </h3>
            <p>{summary?.text ?? 'No summary yet; it is written once Claude replies.'}</p>
            {!!summary?.progress?.length && <ul>{summary.progress.map((k) => <li key={k}>{k}</li>)}</ul>}
          </section>
          {session.lastMessage && <LatestReply key={session.lastMessage} text={session.lastMessage} />}
        </div>
        <aside className={styles.aside}>
          <section>
            <h3 className={styles.label}>Facts</h3>
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
          {artifacts.length > 0 && (
            <section>
              <h3 className={styles.label} title="Visual explanations Claude made in this session">Artifacts</h3>
              <div className={styles.artifacts}>
                {artifacts.map((a) => (
                  <button key={a.id} type="button" onClick={() => showTab('artifacts', a.id)}>
                    <strong>{a.title}</strong>
                    <span>made {ago(a.at)}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
