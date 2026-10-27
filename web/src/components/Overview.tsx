import { useState } from 'react';
import { decisionKey } from '../../../server/decision.ts';
import { acceptance, choose, dismissal, freeze, kindOf, menuAnswer, primary as primaryOf, type Composer as Note } from '../deck.ts';
import type { Request } from '../outbox.ts';
import { queue, useQueue } from '../queue.ts';
import { closeSheet, closeSheetToQueue, showTab } from '../router.ts';
import { hold, useBusy } from '../sends.ts';
import type { MenuAnswer, Session } from '../types.ts';
import { adviceFor, ago, attentionOf, decisionOf } from '../util.ts';
import { Clock } from './Clock.tsx';
import { Composer, editDraft, readyPaths, uploading, useDraft } from './Composer.tsx';
import { LatestReply } from './LatestReply.tsx';
import { MenuBody } from './MenuBody.tsx';
import { Options } from './Options.tsx';
import styles from './Overview.module.css';
import { SecondOpinion } from './SecondOpinion.tsx';
import { FocusButton } from './SessionMenu.tsx';

// A decision answered on its task page: the same options, second opinion and reply box as on its card. A send is held
// with its Undo as from the card, and the box goes with it.
function Queued({ session, name }: { session: Session; name: string }) {
  const q = useQueue();
  const key = decisionKey(session);
  const menu = session.menu;
  const decision = menu ? null : decisionOf(session);
  const advice = adviceFor(session);
  const done = advice?.state === 'done' ? advice : null;
  const frozen = key ? (q.frozen.get(key) ?? freeze(session)) : null;
  const draft = useDraft(session.id);
  const [focus, setFocus] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [picks, showPicks] = useState<MenuAnswer[]>(() =>
    (key && queue.picksOf(key)) || (frozen?.via === 'menu' ? frozen.picks.map((p) => ({ ...p, labels: [...p.labels] })) : []));
  const setPicks = (value: MenuAnswer[]) => {
    showPicks(value);
    if (key) queue.pick(key, value);
  };
  const box: Note = { open: true, text: draft.text, files: readyPaths(draft), uploading: uploading(draft) };
  const send = (r: Request | null) => {
    if (!r) return setNote('An attachment is still uploading; nothing was sent.');
    setNote(r.command ? `${r.label.split(/\s/)[0]} goes to the terminal as typed; the question stays open.` : null);
    hold(session, r, name);
  };
  const questions = menu?.questions ?? [];
  const lone = questions.length === 1 && !questions[0].multiSelect;
  const pickInMenu = (question: number, label: string) => {
    if (lone) return send(menuAnswer(session, [{ labels: [label], other: '' }]));
    const multi = questions[question]?.multiSelect;
    setPicks(picks.map((p, i) => {
      if (i !== question) return p;
      if (multi) return { ...p, labels: p.labels.includes(label) ? p.labels.filter((l) => l !== label) : [...p.labels, label] };
      return { labels: p.labels[0] === label ? [] : [label], other: '' };
    }));
  };
  const menuPress = menu ? primaryOf(session, frozen, { picks }) : null;
  const submitMenu = () => {
    if (menuPress?.press && !('intent' in menuPress.press)) send(menuPress.press);
  };
  const edit = () => {
    if (!done) return;
    const text = done.choice && !done.answer.startsWith(done.choice) ? `${done.choice}. ${done.answer}` : done.answer;
    editDraft(session.id, (d) => ({ ...d, text }));
    setFocus((n) => n + 1);
  };
  const toCard = () => {
    queue.jump(session.id);
    closeSheetToQueue();
  };
  return (
    <section className={styles.queued} data-queued>
      <span className={styles.kicker}>In your queue · {menu ? 'Asked in the terminal' : 'Decision'}</span>
      {decision && (
        <>
          <h3>{decision.problem}</h3>
          <SecondOpinion session={session} advice={advice} />
          <Options
            options={decision.options}
            advice={done}
            frozen={frozen}
            composing={!!draft.text}
            accepting={false}
            onPick={(label) => send(choose(session, label, box))}
            onAccept={() => send(acceptance(session))}
            onEdit={edit}
          />
          <Composer
            session={session}
            decision={decision.key}
            label="Your own answer"
            placeholder={decision.options.length ? 'Or write your own answer, / for commands, paste or drop files…' : 'Reply, / for commands, paste or drop files…'}
            focus={focus}
            note={note}
            onSend={send}
            onEscape={closeSheet}
          />
        </>
      )}
      {menu && (
        <>
          <MenuBody
            session={session}
            menu={menu}
            picks={picks}
            advice={advice}
            onPick={pickInMenu}
            onOther={(question, other) => setPicks(picks.map((p, i) => (i === question ? { labels: other ? [] : p.labels, other } : p)))}
            onPicks={setPicks}
            onSubmit={submitMenu}
          />
          {!lone && (
            <button type="button" data-variant="primary" disabled={menuPress?.disabled} onClick={submitMenu}>{menuPress?.label}</button>
          )}
        </>
      )}
      <div className={styles.queuedActions}>
        {kindOf(session) === 'ask' && (
          <button type="button" title="Clear the question without answering it" onClick={() => send(dismissal(session))}>Dismiss</button>
        )}
        <button type="button" title="Its card in the queue, with Elaborate" onClick={toCard}>Open its card</button>
      </div>
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
          {!archived && attention === 'decide' && !busy.has(session.id) && <Queued session={session} name={name} />}
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
