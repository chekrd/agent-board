import { useState, type CSSProperties, type KeyboardEvent } from 'react';
import { api, type ApiError } from '../api.ts';
import { openSheet } from '../router.ts';
import { useBusy } from '../sends.ts';
import { useStore } from '../store.ts';
import type { Finding, Session, SubtaskKind } from '../types.ts';
import { ancestorsOf, decisionOf, locate, sessionLabel, settledAs, shownOf, type Shown } from '../util.ts';
import styles from './Findings.module.css';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { StateMark } from './StateMark.tsx';
import { STATE_LABELS } from './Status.tsx';
import { resolveSubtask } from './SessionMenu.tsx';
import { toast } from './Toasts.tsx';

type Response = SubtaskKind | 'reject' | 'reopen';

const RESOLVED = { solved: 'Solved', dropped: 'Dropped' } as const;

export const stateLabel = (o: Session, shown: Shown) => (o.resolution ? RESOLVED[o.resolution.state] : o.archived ? 'Archived' : STATE_LABELS[shown]);

export const SUBTASK_LABELS: Record<SubtaskKind, string> = { accept: 'Fix', elaborate: 'Explain', 'second-look': 'Second look', reply: 'Reply' };

const ACTIONS: { kind: SubtaskKind; label: string; title: string }[] = [
  { kind: 'accept', label: 'Accept', title: 'A new agent checks the finding and fixes it in this worktree; your note goes along' },
  { kind: 'elaborate', label: 'Elaborate', title: 'A new agent explains the finding without changing files; your note goes along' },
  { kind: 'second-look', label: 'Second look', title: 'A new agent checks independently whether the finding is real, without changing files' },
];

// The task's findings, each answered on its own: Reject only marks it, every other answer starts a subtask, a new
// Claude in this worktree that gets the finding and the answer and nothing of this conversation. The ones done with
// fold away under Settled.
export function Findings({ session, compact = false }: { session: Session; compact?: boolean }) {
  const findings = session.findings;
  const { sessions } = useStore();
  if (!findings?.items.length) return null;
  const subtasks = sessions.filter((o) => o.parent?.id === session.id && o.parent.basis === findings.basis);
  const items = findings.items.map((finding, index) => {
    const own = subtasks.filter((o) => o.parent!.finding === index);
    return { finding, index, subtasks: own, settled: settledAs(finding, own) };
  });
  const open = items.filter((x) => !x.settled);
  const settled = items.filter((x) => x.settled);
  const item = (x: (typeof items)[number]) => (
    <Item key={`${findings.basis}:${x.index}`} session={session} basis={findings.basis} {...x} compact={compact || !!x.settled} />
  );
  return (
    <section className={styles.findings} data-findings aria-label="Findings">
      <h3 className={styles.label}>
        Findings <span data-settled-count>· {settled.length ? (open.length ? `${open.length} of ${items.length} open` : `all ${items.length} settled`) : items.length}</span>
      </h3>
      {open.length > 0 && <ol>{open.map(item)}</ol>}
      {settled.length > 0 && (
        <details className={styles.settled} data-settled-findings>
          <summary>Settled · {settled.length}</summary>
          <ol>{settled.map(item)}</ol>
        </details>
      )}
    </section>
  );
}

interface ItemProps {
  session: Session;
  basis: string;
  index: number;
  finding: Finding;
  subtasks: Session[];
  settled: Settled;
  compact: boolean;
}

type Settled = ReturnType<typeof settledAs>;

function Item({ session, basis, index, finding, subtasks, settled, compact }: ItemProps) {
  const [expanded, setExpanded] = useState(!compact && index === 0);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const busy = useBusy();
  const n = index + 1;
  const rejected = !!finding.rejected;

  const respond = async (kind: Response) => {
    if (sending) return;
    setSending(true);
    try {
      const { id } = await api<{ id: string | null }>('POST', `/api/sessions/${session.id}/finding`, { basis, finding: index, kind, text: note });
      setNote('');
      if (id) toast('info', `Started #${n} ${SUBTASK_LABELS[kind as SubtaskKind]}`, { action: { label: 'Open', run: () => openSheet(id) } });
    } catch (err) {
      toast('error', `#${n}: ${(err as ApiError).message}`);
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    if (note.trim()) void respond('reply');
  };

  return (
    <li className={styles.item} data-finding={n} data-rejected={rejected || undefined} data-settled={settled ?? undefined}>
      <button type="button" className={styles.head} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className={styles.n}>{n}</span>
        <strong>{finding.title}</strong>
        {finding.location && <code className={styles.where}>{finding.location}</code>}
      </button>
      {expanded && <div className={styles.detail}><Markdown source={finding.detail} /></div>}
      {rejected ? (
        <div className={styles.rejected}>
          <span>Rejected{finding.rejected!.reason ? `: ${finding.rejected!.reason}` : ''}</span>
          <button type="button" disabled={sending} onClick={() => void respond('reopen')}>Reopen</button>
        </div>
      ) : settled ? (
        <div className={styles.rejected}>
          <span>{settled === 'solved' ? 'Solved' : 'Dropped'} in {subtasks.length === 1 ? 'its subtask' : `its ${subtasks.length} subtasks`}</span>
        </div>
      ) : (
        <div className={styles.answer}>
          {expanded && (
            <textarea
              rows={1}
              value={note}
              aria-label={`Note or answer on finding ${n}`}
              placeholder="A note for the agent, or your own answer (Enter replies)…"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={onKey}
            />
          )}
          <div className={styles.actions}>
            {ACTIONS.map((a) => (
              <button key={a.kind} type="button" data-response={a.kind} title={a.title} disabled={sending} onClick={() => void respond(a.kind)}>{a.label}</button>
            ))}
            {expanded && (
              <button type="button" data-response="reply" title="A new agent acts on your answer" disabled={sending || !note.trim()} onClick={() => void respond('reply')}>Reply</button>
            )}
            <button type="button" data-response="reject" className={styles.reject} title="Mark it rejected; your note is kept as the reason. Nothing starts" disabled={sending} onClick={() => void respond('reject')}>Reject</button>
          </div>
        </div>
      )}
      {subtasks.length > 0 && (
        <ul className={styles.subtasks} aria-label={`Subtasks of finding ${n}`}>
          {subtasks.map((o) => {
            const shown = shownOf(o, busy);
            return (
              <li key={o.id}>
                <button type="button" data-subtask={o.id} title={o.parent!.text || undefined} onClick={() => openSheet(o.id)}>
                  <StateMark state={o.archived ? 'archived' : shown} size={8} />
                  <span>{SUBTASK_LABELS[o.parent!.kind]}</span>
                  <span className={styles.state}>{stateLabel(o, shown)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function useParent(session: Session) {
  const { sessions, repos } = useStore();
  const p = session.parent;
  const task = p ? sessions.find((s) => s.id === p.id) : undefined;
  return { p, task, name: task ? sessionLabel(task, locate(repos, task).branch) : 'its task', sessions };
}

// A subtask names the tasks it belongs to wherever it shows, from the root task down: above its title on its page and
// on its card. Each opens its page.
export function ParentCrumb({ session }: { session: Session }) {
  const { sessions, repos } = useStore();
  const busy = useBusy();
  if (!session.parent) return null;
  const chain = ancestorsOf(sessions, session);
  return (
    <span className={styles.crumb} data-parent>
      <Icon name="subtask" size={14} />
      <span className={styles.crumbOf}>Subtask of</span>
      {chain.length ? chain.map((task, i) => (
        <span key={task.id} className={styles.crumbStep}>
          {i > 0 && <span className={styles.crumbSep} aria-hidden>›</span>}
          <button type="button" title="Open this task" onClick={() => openSheet(task.id)}>
            <StateMark state={task.archived ? 'archived' : shownOf(task, busy)} size={7} />
            {sessionLabel(task, locate(repos, task).branch)}
          </button>
        </span>
      )) : <span>its task</span>}
    </span>
  );
}

// On a subtask's page: the task it belongs to, the finding it was started from with your answer, and the finding's
// other subtasks, which work in the same worktree.
export function SubtaskOf({ session }: { session: Session }) {
  const { p, task, name, sessions } = useParent(session);
  const busy = useBusy();
  if (!p) return null;
  const finding = task?.findings?.basis === p.basis ? task.findings.items[p.finding] : undefined;
  const siblings = sessions.filter((o) => o.id !== session.id && o.parent?.id === p.id && o.parent.basis === p.basis && o.parent.finding === p.finding);
  const taskState = task ? (task.archived ? 'archived' : shownOf(task, busy)) : null;
  return (
    <section className={styles.origin} aria-label="Subtask of">
      <div className={styles.originTask}>
        <span className={styles.label}><Icon name="subtask" size={14} />Subtask of</span>
        {task ? (
          <button type="button" className={styles.originName} title="Open the task this subtask belongs to" onClick={() => openSheet(task.id)}>
            {name}
          </button>
        ) : <strong className={styles.originName}>{name}</strong>}
        {taskState && (
          <span className={styles.state}>
            <StateMark state={taskState} size={8} />
            {taskState === 'archived' ? 'Archived' : STATE_LABELS[taskState]}
          </span>
        )}
        {task && (
          <button type="button" className={styles.back} onClick={() => openSheet(task.id)}>
            <Icon name="arrow-left" size={14} />Back to the task
          </button>
        )}
      </div>
      <div className={styles.originFinding}>
        <span className={styles.n}>{p.finding + 1}</span>
        <div>
          <strong>{p.title}</strong>
          {finding?.location && <code className={styles.where}>{finding.location}</code>}
          {finding?.detail && <div className={styles.detail}><Markdown source={finding.detail} /></div>}
          <p className={styles.asked}>
            <span className={styles.kind}>{SUBTASK_LABELS[p.kind]}</span>
            {p.text ? <q>{p.text}</q> : <span className={styles.state}>without a note</span>}
          </p>
        </div>
      </div>
      {siblings.length > 0 && (
        <ul className={styles.subtasks} aria-label={`Other subtasks of finding ${p.finding + 1}`}>
          {siblings.map((o) => {
            const shown = shownOf(o, busy);
            return (
              <li key={o.id}>
                <button type="button" data-subtask={o.id} title={o.parent!.text || undefined} onClick={() => openSheet(o.id)}>
                  <StateMark state={o.archived ? 'archived' : shown} size={8} />
                  <span>{SUBTASK_LABELS[o.parent!.kind]}</span>
                  <span className={styles.state}>{stateLabel(o, shown)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className={styles.resolve} data-resolve>
        {session.resolution ? (
          <>
            <span className={styles.resolved} data-resolution={session.resolution.state}>
              <Icon name={session.resolution.state === 'solved' ? 'check' : 'close'} size={14} />
              {RESOLVED[session.resolution.state]}
            </span>
            <button type="button" onClick={() => resolveSubtask(session, null, session.title ?? 'the subtask')}>Reopen</button>
          </>
        ) : (
          <>
            <span className={styles.state}>Done with it?</span>
            <button type="button" data-variant="primary" onClick={() => resolveSubtask(session, 'solved', session.title ?? 'the subtask')}>Mark solved</button>
            <button type="button" onClick={() => resolveSubtask(session, 'dropped', session.title ?? 'the subtask')}>Drop</button>
          </>
        )}
      </div>
    </section>
  );
}

const URGENCY: Record<string, number> = { decide: 0, focus: 1, idle: 2, sending: 3, working: 4, exited: 5 };

// On a task's page: every subtask under it, a subtask's own subtasks indented under it, and among siblings the ones
// that want you first. The Wall leaves them to their root task's tile, so this is where they are listed. A solved or
// dropped one folds away under Settled with everything under it.
export function Subtasks({ session }: { session: Session }) {
  const { sessions, repos } = useStore();
  const busy = useBusy();
  const stateOf = (o: Session) => (o.archived ? ('archived' as const) : shownOf(o, busy));
  type Row = { o: Session; depth: number };
  const open: Row[] = [];
  const settled: Row[] = [];
  const children = (id: string) => sessions
    .filter((o) => o.parent?.id === id)
    .sort((a, b) => (URGENCY[stateOf(a)] ?? 9) - (URGENCY[stateOf(b)] ?? 9) || a.createdAt - b.createdAt);
  const walk = (id: string, depth: number, into: Row[]) => {
    for (const o of children(id)) {
      const to = into === open && o.resolution ? settled : into;
      const at = to === into ? depth : 0;
      to.push({ o, depth: at });
      walk(o.id, at + 1, to);
    }
  };
  walk(session.id, 0, open);
  const total = open.length + settled.length;
  if (!total) return null;
  const row = ({ o, depth }: Row) => {
    const state = stateOf(o);
    return (
      <li key={o.id} data-depth={depth} data-resolution={o.resolution?.state} style={{ '--depth': depth } as CSSProperties}>
        {depth > 0 && <Icon name="subtask" size={14} />}
        <button type="button" data-subtask={o.id} data-attention={state} onClick={() => openSheet(o.id)}>
          <StateMark state={state} size={8} />
          <strong>{sessionLabel(o, locate(repos, o).branch)}</strong>
          <span className={styles.listState}>{stateLabel(o, shownOf(o, busy))}</span>
          <span className={styles.listText}>{state === 'working' ? (o.activity?.step ?? 'Starting') : (state === 'decide' ? decisionOf(o)?.problem : o.summary?.text) || o.parent!.text}</span>
        </button>
      </li>
    );
  };
  return (
    <section className={styles.list} aria-label="Subtasks" data-subtask-list>
      <h3 className={styles.label}>Subtasks <span data-open-count>· {open.length ? `${open.length} of ${total} open` : `all ${total} solved or dropped`}</span></h3>
      {open.length > 0 && <ul>{open.map(row)}</ul>}
      {settled.length > 0 && (
        <details className={styles.settled} data-settled-subtasks>
          <summary>Settled · {settled.length}</summary>
          <ul>{settled.map(row)}</ul>
        </details>
      )}
    </section>
  );
}
