import { useState } from 'react';
import { api } from '../api.ts';
import { openSheet } from '../router.ts';
import { useStore } from '../store.ts';
import type { Session } from '../types.ts';
import { attentionOf, locate, sessionLabel, type Shown } from '../util.ts';
import { Clock } from './Clock.tsx';
import styles from './RestartBanner.module.css';
import { STATE_LABELS } from './Status.tsx';
import { toast } from './Toasts.tsx';

// What the task showed when the restart killed its Claude: a decision and a finished turn both leave it idle.
export function interruptedAs(s: Session) {
  const i = s.interrupted!;
  return attentionOf({ ...s, status: i.status, waitingFor: i.waitingFor, menu: i.menu });
}

export const cutShort = (s: Session) => !!s.interrupted && s.status !== 'exited';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ORDER: Shown[] = ['decide', 'focus', 'idle', 'working'];

function counts(tasks: Session[]) {
  const was = tasks.map(interruptedAs);
  return ORDER.flatMap((a) => {
    const n = was.filter((w) => w === a).length;
    return n ? [`${n} ${STATE_LABELS[a].toLowerCase()}`] : [];
  }).join(', ');
}

function TaskLinks({ tasks }: { tasks: Session[] }) {
  const { repos } = useStore();
  return tasks.map((s, i) => (
    <span key={s.id}>
      {i > 0 && ', '}
      <button type="button" className={styles.task} onClick={() => openSheet(s.id)}>{sessionLabel(s, locate(repos, s).branch)}</button>
    </span>
  ));
}

function Preparing({ safeAt, sessions }: { safeAt: number | null; sessions: Session[] }) {
  const live = sessions.filter((s) => s.status !== 'exited');
  const working = live.filter((s) => s.status === 'working');
  const longest = working.reduce<Session | null>((a, s) => (!a || (s.activity?.since ?? Infinity) < (a.activity?.since ?? Infinity) ? s : a), null);
  const cancel = () => api('POST', '/api/restart/prepare', { on: false }).catch(reportError);
  return (
    <section className={styles.banner} data-restart={safeAt ? 'safe' : 'preparing'} aria-live="polite">
      {safeAt ? (
        <p>
          <strong>Safe to restart.</strong>{' '}
          {live.length ? <>No Claude is in the middle of a turn; after the restart, Resume all brings {live.length === 1 ? 'the task' : `the ${live.length} tasks`} back.</> : 'No Claude is running.'}
        </p>
      ) : (
        <p>
          <strong>Getting ready to restart</strong> · {live.length - working.length} of {plural(live.length, 'task')} safe · waiting on <TaskLinks tasks={working} />
          {longest?.activity && <> (the longest turn has run <Clock since={longest.activity.since} />)</>}
        </p>
      )}
      <button type="button" onClick={cancel}>{safeAt ? 'Done' : 'Cancel'}</button>
    </section>
  );
}

export function RestartBanner() {
  const { sessions, restart } = useStore();
  const [resuming, setResuming] = useState(false);
  if (restart.preparing) return <Preparing {...restart.preparing} sessions={sessions} />;
  const ended = sessions.filter((s) => s.status === 'exited' && s.interrupted && !s.archived);
  const midTurn = sessions.filter((s) => cutShort(s) && !s.archived);
  if (!ended.length && !midTurn.length) return null;

  const resume = async () => {
    setResuming(true);
    try {
      const { failed } = await api<{ resumed: number; failed: { id: string; error: string }[] }>('POST', '/api/restart/resume');
      for (const f of failed) toast('error', `Not resumed: ${f.error}`, { session: f.id });
    } catch (err) {
      reportError(err);
    } finally {
      setResuming(false);
    }
  };
  const dismiss = () => api('POST', '/api/restart/dismiss').catch(reportError);

  return (
    <section className={styles.banner} data-restart="recover" aria-live="polite">
      {ended.length > 0 ? (
        <p>
          <strong>The Mac restarted</strong> and ended {plural(ended.length, 'task')} with it: {counts(ended)}.
          {' '}Resume all continues each one in a hidden terminal, where it was.
        </p>
      ) : (
        <p>
          <strong>{plural(midTurn.length, 'task was', 'tasks were')} cut short mid-turn</strong> by the restart: <TaskLinks tasks={midTurn} />.
          {' '}Each waits for you; Continue the turn on its page picks it up.
        </p>
      )}
      {ended.length > 0 && <button type="button" data-variant="primary" disabled={resuming} onClick={resume}>{resuming ? 'Resuming…' : 'Resume all'}</button>}
      <button type="button" onClick={dismiss} title="Forget what the restart cut short; ended tasks stay on the Wall, Continue brings one back">Dismiss</button>
    </section>
  );
}
