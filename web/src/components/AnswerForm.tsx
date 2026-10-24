import { useActionState, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, sessionAction } from '../api.ts';
import type { Advice, Command, Session } from '../types.ts';
import styles from './AnswerForm.module.css';

export function AnswerForm({ session, compact = false }: { session: Session; compact?: boolean }) {
  const q = session.question;
  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const intent = form.get('intent');
      if (intent === 'dismiss') await sessionAction(session.id, 'dismiss');
      else if (intent === 'accept') await sessionAction(session.id, 'accept-advice');
      else if (intent === 'retry') await sessionAction(session.id, 'retry-advice');
      else if (intent === 'stop') await sessionAction(session.id, 'stop-advice');
      else await sessionAction(session.id, 'answer', { choice: form.get('choice') || undefined, text: form.get('text') || undefined });
      setDraft('');
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);
  const reply = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [picked, setPicked] = useState(0);
  const [closed, setClosed] = useState(false);
  const [focused, setFocused] = useState(false);
  const commands = useCommands(session.worktree, focused || draft.startsWith('/'));
  const query = /^\/\S*$/.test(draft) && !closed ? draft.slice(1).toLowerCase() : null;
  const matches = query === null ? [] : rank(commands, query);

  const fill = (value: string) => {
    setDraft(value);
    reply.current?.focus();
  };

  const edit = (a: Advice) => fill([a.choice && `${a.choice}.`, a.answer].filter(Boolean).join(' '));

  const complete = (c: Command) => {
    fill(`/${c.name} `);
    setClosed(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const current = matches[picked % matches.length];
    const exact = matches.some((c) => `/${c.name}` === draft);
    if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setPicked((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (matches.length && e.key === 'Escape') {
      setClosed(true);
    } else if (matches.length && (e.key === 'Tab' || (e.key === 'Enter' && !exact))) {
      e.preventDefault();
      complete(current);
    } else if (e.key === 'Enter') {
      // Implicit submission would click the form's first submit button (an option or Accept).
      if (e.shiftKey && e.currentTarget instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      if (draft.trim()) e.currentTarget.form?.requestSubmit();
    }
  };

  const onInput = (value: string) => {
    setDraft(value);
    setPicked(0);
    if (!value.startsWith('/')) setClosed(false);
    else if (/\s/.test(value)) setClosed(true);
    else setClosed(false);
  };

  const field = {
    ref: reply,
    name: 'text',
    placeholder: 'Reply, or / for commands…',
    disabled: pending,
    value: draft,
    onKeyDown,
    onFocus: () => setFocused(true),
    onChange: (e: { currentTarget: { value: string } }) => onInput(e.currentTarget.value),
  };

  return (
    <form className={styles.form} action={submit} data-compact={compact || undefined}>
      {q && session.advice && <SecondOpinion advice={session.advice} compact={compact} pending={pending} onEdit={edit} />}
      {q && q.options.length > 0 && (
        <div className={styles.options}>
          {q.options.map((o) => (
            <button
              key={o.label}
              type="submit"
              name="choice"
              value={o.label}
              disabled={pending}
              data-variant={o.recommended ? 'primary' : undefined}
              title={o.description}
            >
              {o.label}
              {!compact && o.description && <small>{o.description}</small>}
            </button>
          ))}
        </div>
      )}
      <div className={styles.reply}>
        {matches.length > 0 && (
          <ul className={styles.commands} role="listbox">
            {matches.map((c, i) => (
              <li
                key={c.name}
                role="option"
                aria-selected={i === picked % matches.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  complete(c);
                }}
              >
                <code>/{c.name}</code>
                <span>{c.description}</span>
              </li>
            ))}
          </ul>
        )}
        {compact ? <input {...field} autoComplete="off" /> : <textarea {...field} rows={3} />}
        {q && (
          <button type="submit" name="intent" value="dismiss" data-variant="ghost" disabled={pending} title="Clear without answering">
            Dismiss
          </button>
        )}
      </div>
      {error && <p className={styles.error}>{error}</p>}
    </form>
  );
}

const COMMANDS_FRESH_MS = 60_000;
const commandCache = new Map<string, { at: number; list: Promise<Command[]> }>();

function useCommands(worktree: string, wanted: boolean) {
  const [commands, setCommands] = useState<Command[]>([]);
  useEffect(() => {
    if (!wanted) return;
    const cached = commandCache.get(worktree);
    if (!cached || Date.now() - cached.at > COMMANDS_FRESH_MS) {
      const list = api<Command[]>('GET', `/api/commands?worktree=${encodeURIComponent(worktree)}`);
      list.catch(() => commandCache.delete(worktree));
      commandCache.set(worktree, { at: Date.now(), list });
    }
    let live = true;
    commandCache.get(worktree)!.list.then((list) => live && setCommands(list), () => {});
    return () => {
      live = false;
    };
  }, [worktree, wanted]);
  return commands;
}

function rank(commands: Command[], query: string) {
  const score = (c: Command) => {
    const name = c.name.toLowerCase();
    if (name === query) return -1;
    if (name.startsWith(query)) return 0;
    if (name.split(':').at(-1)!.startsWith(query)) return 1;
    return name.includes(query) ? 2 : 3;
  };
  return commands.map((c) => ({ c, s: score(c) })).filter((x) => x.s < 3).sort((a, b) => a.s - b.s).slice(0, 8).map((x) => x.c);
}

const level = (confidence: number) => (confidence >= 75 ? 'high' : confidence >= 50 ? 'medium' : 'low');

function SecondOpinion({ advice: a, compact, pending, onEdit }: { advice: Advice; compact: boolean; pending: boolean; onEdit: (a: Advice) => void }) {
  if (a.state === 'thinking') {
    return (
      <div className={styles.advice} data-state="running">
        <div className={styles.adviceHead}>
          <span className={styles.spinner} aria-hidden />
          <span>Second opinion in progress · <Elapsed since={a.startedAt} /></span>
          <button type="submit" name="intent" value="stop" data-variant="ghost" disabled={pending} title="Stop the advisor">Stop</button>
        </div>
        <p className={styles.activity}>{a.activity ?? 'Working'}</p>
      </div>
    );
  }
  if (a.state === 'failed') {
    return (
      <div className={styles.advice} data-state="failed" title={a.error}>
        <span>{a.error === 'stopped' ? 'Second opinion stopped' : `Second opinion failed: ${a.error}`}</span>
        <button type="submit" name="intent" value="retry" data-variant="ghost" disabled={pending}>Retry</button>
      </div>
    );
  }
  return (
    <div className={styles.advice}>
      <div className={styles.adviceHead}>
        <span>Second opinion</span>
        <span className={styles.confidence} data-level={level(a.confidence)} title="How sure the advisor is that you would decide the same">
          {a.confidence}%
        </span>
      </div>
      {a.choice && <strong className={styles.adviceChoice}>{a.choice}</strong>}
      {a.answer && <p className={styles.adviceAnswer} data-compact={compact || undefined}>{a.answer}</p>}
      {a.reasoning && <p className={styles.adviceReason} data-compact={compact || undefined} title={compact ? a.reasoning : undefined}>{a.reasoning}</p>}
      <div className={styles.adviceActions}>
        <button type="submit" name="intent" value="accept" data-variant="primary" disabled={pending}>Accept &amp; send</button>
        <button type="button" data-variant="ghost" disabled={pending} onClick={() => onEdit(a)}>Edit</button>
      </div>
    </div>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return <>{Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}</>;
}
