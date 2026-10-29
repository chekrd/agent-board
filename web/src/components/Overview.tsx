import { useEffect, useState } from 'react';
import { decisionKey } from '../../../server/decision.ts';
import { acceptance, choose, dismissal, freeze, kindOf, menuAnswer, primary as primaryOf, type Composer as Note } from '../deck.ts';
import type { Request } from '../outbox.ts';
import { queue, useQueue } from '../queue.ts';
import { closeSheet, closeSheetToQueue, showTab } from '../router.ts';
import { hold, useBusy } from '../sends.ts';
import { useStore } from '../store.ts';
import type { MenuAnswer, RepoView, Session } from '../types.ts';
import { adviceFor, ago, attentionOf, decisionOf, effortName, modelName, shortUrl, tilde, worktreeName } from '../util.ts';
import { Clock } from './Clock.tsx';
import { Composer, editDraft, readyPaths, uploading, useDraft } from './Composer.tsx';
import { Findings, Subtasks, SubtaskOf } from './Findings.tsx';
import { Icon } from './Icon.tsx';
import { LatestReply } from './LatestReply.tsx';
import { MenuBody } from './MenuBody.tsx';
import { Options } from './Options.tsx';
import styles from './Overview.module.css';
import { SecondOpinion } from './SecondOpinion.tsx';
import { FocusButton } from './SessionMenu.tsx';
import { toast } from './Toasts.tsx';

const COPIED_MS = 1500;

function Copy({ value, what, title, shown = value }: { value: string; what: string; title?: string; shown?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () => navigator.clipboard.writeText(value).then(
    () => setCopied(true),
    () => toast('error', `Could not copy the ${what.toLowerCase()}`),
  );
  return (
    <button type="button" className={styles.copy} data-copied={copied || undefined} title={title} aria-label={`Copy ${what.toLowerCase()} ${value}`} onClick={copy}>
      <code>{shown}</code>
      <span className={styles.copyMark} aria-live="polite">
        <Icon name={copied ? 'check' : 'copy'} size={13} />
        {copied && 'Copied'}
      </span>
    </button>
  );
}

// A decision answered on its task page: the same options, second opinion and reply box as on its card. A send is held
// with its Undo as from the card, and the box goes with it. `box` is off while Message Claude stays for the writing in it.
function Queued({ session, name, box: ownBox }: { session: Session; name: string; box: boolean }) {
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
          {ownBox && <Composer
            session={session}
            decision={decision.key}
            label="Your own answer"
            placeholder={decision.options.length ? 'Or write your own answer, / for commands, paste or drop files…' : 'Reply, / for commands, paste or drop files…'}
            focus={focus}
            note={note}
            onSend={send}
            onEscape={closeSheet}
          />}
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

export function Overview({ session, name, branch, repo }: { session: Session; name: string; branch?: string; repo?: RepoView }) {
  const { home } = useStore();
  const busy = useBusy();
  const { summary, activity } = session;
  const attention = attentionOf(session);
  const { archived } = session;
  const working = session.status === 'working';
  const message = !archived && (attention === 'working' || attention === 'idle');
  // Message Claude stays while focus is in it, also with the window away, whatever the state turns to: a dictation app
  // inserts into the field it started on, and a new box would not be that field. The server refuses a message while
  // Claude shows a prompt, and the text comes back.
  const [writing, setWriting] = useState(false);
  if (archived && writing) setWriting(false);
  const learnings = summary?.learnings ?? [];
  const artifacts = session.artifacts.toReversed();
  const links = session.links.toReversed();
  return (
    <div className={styles.scroll}>
      <div className={styles.grid}>
        <div className={styles.main}>
          <SubtaskOf session={session} />
          {working && (
            <section className={styles.working}>
              <span className={styles.spinner} aria-hidden />
              <div className={styles.step}>
                <strong>{activity?.between ? 'Waiting on background work' : 'Claude is working'}</strong>
                {!activity?.between && <code>{activity?.step ?? 'Starting'}</code>}
                {!!activity?.background?.length && (
                  <ul className={styles.background} aria-label="In the background" data-between={activity.between}>
                    {activity.background.map((b, i) => <li key={i}><code>{b}</code></li>)}
                  </ul>
                )}
              </div>
              {activity && <span className={styles.clock} title="Time since your last message"><Clock since={activity.since} /></span>}
            </section>
          )}
          {!archived && attention === 'decide' && !busy.has(session.id) && <Queued session={session} name={name} box={!writing} />}
          <Findings session={session} />
          {!archived && attention === 'focus' && (
            <section className={styles.blocked}>
              <p>Claude is showing <strong>{session.waitingFor ?? 'a prompt'}</strong> in its terminal. Answer it there.</p>
              <FocusButton session={session} />
            </section>
          )}
          {(message || (writing && !archived)) && (
            <div
              className={styles.message}
              onFocus={() => setWriting(true)}
              onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget) && (e.relatedTarget || document.hasFocus())) setWriting(false);
              }}
            >
              <Composer
                session={session}
                decision={null}
                label="Message Claude"
                placeholder="Reply, / for commands, paste or drop files…"
                focus={0}
                onSend={(r) => void hold(session, r, name)}
                onEscape={closeSheet}
              />
            </div>
          )}
          <section className={styles.status}>
            <h3 className={styles.label} title="A short summary of the session, rewritten by a model after each of Claude's messages">
              Session summary {summary && <span>· updated {ago(summary.at)}</span>}
            </h3>
            <p>{summary?.text || 'No summary yet; it is written once Claude replies.'}</p>
            {!!summary?.progress?.length && <ul>{summary.progress.map((k) => <li key={k}>{k}</li>)}</ul>}
          </section>
          {learnings.length > 0 && (
            <section className={styles.know}>
              <h3 className={styles.label} title="Something notable Claude found or learned; shown only when it is worth your attention">Worth knowing</h3>
              {learnings.map((k) => <p key={k}>{k}</p>)}
            </section>
          )}
          {session.lastMessage && <LatestReply key={session.lastMessage} text={session.lastMessage} />}
        </div>
        <aside className={styles.aside}>
          <section aria-label="Facts">
            <dl className={styles.facts}>
              {session.parent ? (
                <>
                  <dt>Finding</dt>
                  <dd>#{session.parent.finding + 1} {session.parent.title}</dd>
                </>
              ) : (
                <>
                  <dt>Task</dt>
                  <dd>{session.firstPrompt ?? '—'}</dd>
                </>
              )}
              {repo && (
                <>
                  <dt>Repository</dt>
                  <dd>{repo.name}</dd>
                </>
              )}
              <dt>Worktree</dt>
              <dd>{worktreeName(session.worktree, repo)}</dd>
              <dt>Path</dt>
              <dd><Copy value={session.worktree} shown={tilde(session.worktree, home)} what="Worktree path" /></dd>
              {branch && (
                <>
                  <dt>Branch</dt>
                  <dd><Copy value={branch} what="Branch" /></dd>
                </>
              )}
              <dt title="The model Claude runs on now and its effort, as its last request named them; /model and /effort change them">Model</dt>
              <dd>{session.model ? modelName(session.model) : '—'}{session.effort && ` @ ${effortName(session.effort).toLowerCase()}`}</dd>
              <dt title="The terminal device Claude runs on">Terminal</dt>
              <dd title="The terminal device Claude runs on">{session.tty ? <code>{session.tty}</code> : '—'}</dd>
              <dt title="Claude Code's session id; claude --resume takes it">Session</dt>
              <dd><Copy value={session.conversation} what="Session id" title="Claude Code's session id; claude --resume takes it" /></dd>
            </dl>
          </section>
          {links.length > 0 && (
            <section data-links>
              <h3 className={styles.label} title="Every web link Claude gave in this task, newest first; each opens in your default browser">Links</h3>
              <ul className={styles.links}>
                {links.map((l) => (
                  <li key={l.url}>
                    <a href={l.url} target="_blank" rel="noreferrer" title={l.context || l.url}>
                      <strong>{l.about || l.text || shortUrl(l.url)}</strong>
                      <span>{l.about || l.text ? `${shortUrl(l.url)} · ` : ''}{ago(l.at)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <Subtasks session={session} />
          {session.history.length > 0 && (
            <section>
              <h3 className={styles.label} title="The conversations this task had before a /clear started the one it has now; claude --resume takes their ids">Earlier conversations</h3>
              <ul className={styles.history}>
                {session.history.toReversed().map((h) => (
                  <li key={h.id}>
                    <span>Cleared {ago(h.until)}</span>
                    {h.lastMessage && <p>{h.lastMessage}</p>}
                    <Copy value={h.id} what="Session id" title="claude --resume takes it" />
                  </li>
                ))}
              </ul>
            </section>
          )}
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
