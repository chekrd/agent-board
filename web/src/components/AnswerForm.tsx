import { useActionState, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, sessionAction } from '../api.ts';
import type { Advice, Command, QuestionOption, Session } from '../types.ts';
import styles from './AnswerForm.module.css';
import { Elapsed } from './Elapsed.tsx';

// Outside the component: Detail remounts the form when a decision opens or clears.
const drafts = new Map<string, string>();

export function AnswerForm({ session, options = [] }: { session: Session; options?: QuestionOption[] }) {
  const q = session.question;
  const [error, submit, pending] = useActionState(async (_prev: string | null, form: FormData) => {
    try {
      const intent = form.get('intent');
      if (intent === 'dismiss') await sessionAction(session.id, 'dismiss');
      else if (intent === 'accept') await sessionAction(session.id, 'accept-advice');
      else if (intent === 'retry') await sessionAction(session.id, 'retry-advice');
      else if (intent === 'stop') await sessionAction(session.id, 'stop-advice');
      else {
        await sessionAction(session.id, 'answer', { choice: form.get('choice') || undefined, text: form.get('text') || undefined });
        setDraft('');
      }
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }, null);
  const reply = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? '');
  const setDraft = (value: string) => {
    drafts.set(session.id, value);
    setDraftState(value);
  };
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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
      if (e.shiftKey) return;
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
    placeholder: options.length ? 'Or write your own answer, / for commands…' : 'Reply, or / for commands…',
    disabled: pending,
    value: draft,
    onKeyDown,
    onFocus: () => setFocused(true),
    onChange: (e: { currentTarget: { value: string } }) => onInput(e.currentTarget.value),
  };

  return (
    <form className={styles.form} action={submit}>
      {q && session.advice && <SecondOpinion advice={session.advice} pending={pending} onEdit={edit} />}
      {options.length > 0 && (
        <div className={styles.options}>
          {options.map((o) => (
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
              {o.description && <small>{o.description}</small>}
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
        <textarea {...field} rows={2} />
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

function SecondOpinion({ advice: a, pending, onEdit }: { advice: Advice; pending: boolean; onEdit: (a: Advice) => void }) {
  if (a.state === 'thinking') {
    return (
      <div className={styles.advice} data-state="running">
        <div className={styles.adviceHead}>
          <span className={styles.spinner} aria-hidden />
          <span title="Another model reads the code and suggests what you would likely answer">Second opinion in progress · <Elapsed since={a.startedAt} /></span>
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
        <button type="submit" name="intent" value="retry" data-variant="ghost" disabled={pending} title="Ask for a second opinion again">Retry</button>
      </div>
    );
  }
  return (
    <div className={styles.advice}>
      <div className={styles.adviceHead}>
        <span title="Another model's suggestion of what you would likely answer; nothing is sent until you accept">Second opinion</span>
        <span className={styles.confidence} data-level={level(a.confidence)} title="How sure the advisor is that you would decide the same">
          {a.confidence}%
        </span>
      </div>
      {a.choice && <strong className={styles.adviceChoice}>{a.choice}</strong>}
      {a.answer && <p className={styles.adviceAnswer}>{a.answer}</p>}
      {a.reasoning && <p className={styles.adviceReason}>{a.reasoning}</p>}
      <div className={styles.adviceActions}>
        <button type="submit" name="intent" value="accept" data-variant="primary" disabled={pending} title="Send the suggested answer to Claude">Accept &amp; send</button>
        <button type="button" data-variant="ghost" disabled={pending} onClick={() => onEdit(a)} title="Copy the suggestion into the reply box to change it first">Edit</button>
      </div>
    </div>
  );
}
