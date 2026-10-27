import { queue } from '../queue.ts';
import { closeSheet, closeSheetToQueue, showTab } from '../router.ts';
import { hold, useBusy } from '../sends.ts';
import type { Advice, Session } from '../types.ts';
import { adviceFor, ago, attentionOf, decisionOf } from '../util.ts';
import { Clock } from './Clock.tsx';
import { Composer } from './Composer.tsx';
import { LatestReply } from './LatestReply.tsx';
import styles from './Overview.module.css';
import parts from './Parts.module.css';
import { level, SecondOpinion } from './SecondOpinion.tsx';
import { FocusButton } from './SessionMenu.tsx';

function picked(s: Session, a: Advice) {
  return a.choice ?? (s.menu ? (a.answers ?? []).map((x) => x.other || x.labels.join(', ')).join(' · ') : a.answer);
}

// A decision is answered on its card, never in the sheet: the box says what waits, with the whole second opinion, and
// takes the reader there.
function Queued({ session }: { session: Session }) {
  const problem = session.menu ? session.menu.questions.map((q) => q.question).join(' · ') : decisionOf(session)?.problem;
  const advice = adviceFor(session);
  const done = advice?.state === 'done' ? advice : null;
  const answer = () => {
    queue.jump(session.id);
    closeSheetToQueue();
  };
  return (
    <section className={styles.queued} data-queued>
      <span className={styles.kicker}>In your queue · {session.menu ? 'Asked in the terminal' : 'Decision'}</span>
      <h3>{problem}</h3>
      <SecondOpinion session={session} advice={advice} />
      {done && (
        <div className={styles.opinion} data-advice="done">
          <span className={parts.tag} title="Another model's suggestion of what you would likely answer">
            Second opinion · {done.confidence}% · {level(done.confidence)}
          </span>
          <strong>{picked(session, done)}</strong>
          {done.reasoning && <p>{done.reasoning}</p>}
        </div>
      )}
      <button type="button" data-variant="primary" onClick={answer}>Answer it on its card</button>
    </section>
  );
}

export function Overview({ session, name }: { session: Session; name: string }) {
  const busy = useBusy();
  const { summary, activity } = session;
  const attention = attentionOf(session);
  const { archived } = session;
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
          {!archived && attention === 'decide' && !busy.has(session.id) && <Queued session={session} />}
          {!archived && attention === 'focus' && (
            <section className={styles.blocked}>
              <p>Claude is showing <strong>{session.waitingFor ?? 'a prompt'}</strong> in its terminal. Answer it there.</p>
              <FocusButton session={session} />
            </section>
          )}
          {!archived && (attention === 'working' || attention === 'idle') && (
            <Composer
              session={session}
              decision={null}
              label="Message Claude"
              placeholder="Reply, / for commands, paste or drop files…"
              focus={0}
              onSend={(r) => void hold(session, r, name)}
              onEscape={closeSheet}
            />
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
          <section aria-label="Facts">
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
