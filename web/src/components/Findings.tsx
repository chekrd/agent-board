import { useState, type KeyboardEvent } from 'react';
import { api, type ApiError } from '../api.ts';
import { openSheet } from '../router.ts';
import { useBusy } from '../sends.ts';
import { useStore } from '../store.ts';
import type { Finding, Session, SubtaskKind } from '../types.ts';
import { locate, sessionLabel, shownOf } from '../util.ts';
import styles from './Findings.module.css';
import { Icon } from './Icon.tsx';
import { Markdown } from './Markdown.tsx';
import { StateMark } from './StateMark.tsx';
import { STATE_LABELS } from './Status.tsx';
import { toast } from './Toasts.tsx';

type Response = SubtaskKind | 'reject' | 'reopen';

export const SUBTASK_LABELS: Record<SubtaskKind, string> = { accept: 'Fix', elaborate: 'Explain', 'second-look': 'Second look', reply: 'Reply' };

const ACTIONS: { kind: SubtaskKind; label: string; title: string }[] = [
  { kind: 'accept', label: 'Accept', title: 'A new agent checks the finding and fixes it in this worktree; your note goes along' },
  { kind: 'elaborate', label: 'Elaborate', title: 'A new agent explains the finding without changing files; your note goes along' },
  { kind: 'second-look', label: 'Second look', title: 'A new agent checks independently whether the finding is real, without changing files' },
];

// The task's findings, each answered on its own: Reject only marks it, every other answer starts a subtask, a new
// Claude in this worktree that gets the finding and the answer and nothing of this conversation.
export function Findings({ session, compact = false }: { session: Session; compact?: boolean }) {
  const findings = session.findings;
  const { sessions } = useStore();
  if (!findings?.items.length) return null;
  const subtasks = sessions.filter((o) => o.parent?.id === session.id && o.parent.basis === findings.basis);
  const open = findings.items.filter((f) => !f.rejected).length;
  return (
    <section className={styles.findings} data-findings aria-label="Findings">
      <h3 className={styles.label}>
        Findings <span>· {findings.items.length}{open < findings.items.length ? `, ${findings.items.length - open} rejected` : ''}</span>
      </h3>
      <ol>
        {findings.items.map((f, i) => (
          <Item
            key={`${findings.basis}:${i}`}
            session={session}
            basis={findings.basis}
            index={i}
            finding={f}
            subtasks={subtasks.filter((o) => o.parent!.finding === i)}
            compact={compact}
          />
        ))}
      </ol>
    </section>
  );
}

interface ItemProps {
  session: Session;
  basis: string;
  index: number;
  finding: Finding;
  subtasks: Session[];
  compact: boolean;
}

function Item({ session, basis, index, finding, subtasks, compact }: ItemProps) {
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
    <li className={styles.item} data-finding={n} data-rejected={rejected || undefined}>
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
                  <span className={styles.state}>{o.archived ? 'Archived' : STATE_LABELS[shown]}</span>
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

// A subtask names the task it belongs to wherever it shows: above its title on its page, on its tile and its card.
export function ParentCrumb({ session }: { session: Session }) {
  const { p, task, name } = useParent(session);
  const busy = useBusy();
  if (!p) return null;
  const state = task ? (task.archived ? 'archived' : shownOf(task, busy)) : null;
  return (
    <span className={styles.crumb} data-parent>
      <Icon name="subtask" size={14} />
      <span className={styles.crumbOf}>Subtask of</span>
      {task ? (
        <button type="button" title="Open the task this subtask belongs to" onClick={() => openSheet(task.id)}>
          {state && <StateMark state={state} size={7} />}
          {name}
        </button>
      ) : <span>{name}</span>}
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
                  <span className={styles.state}>{o.archived ? 'Archived' : STATE_LABELS[shown]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
