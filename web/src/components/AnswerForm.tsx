import { useActionState, useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { api, sessionAction, upload } from '../api.ts';
import type { Advice, Command, Menu, Session } from '../types.ts';
import { adviceFor, type DecisionView } from '../util.ts';
import styles from './AnswerForm.module.css';
import { Elapsed } from './Elapsed.tsx';

// Outside the component: Detail remounts the form when a decision opens or clears.
const drafts = new Map<string, string>();
const attachments = new Map<string, Attachment[]>();

interface Attachment {
  id: string;
  name: string;
  preview: string | null;
  path: string | null;
  error: string | null;
}

export function AnswerForm({ session, decision = null }: { session: Session; decision?: DecisionView | null }) {
  const q = session.question;
  const options = decision?.options ?? [];
  const key = decision?.key ?? null;
  const advice = adviceFor(session);
  // Failures go to toasts: most mean the page is behind, and catching up replaces this form.
  const [, submit, pending] = useActionState(async (_prev: null, form: FormData) => {
    try {
      const intent = form.get('intent');
      if (intent === 'dismiss') await sessionAction(session.id, 'dismiss', { key });
      else {
        await sessionAction(session.id, 'answer', { key, choice: form.get('choice') || undefined, text: form.get('text') || undefined, files: form.getAll('file') });
        setDraft('');
        clearFiles();
      }
    } catch (err) {
      reportError(err);
    }
    return null;
  }, null);
  const reply = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraftState] = useState(() => drafts.get(session.id) ?? '');
  const setDraft = (value: string) => {
    drafts.set(session.id, value);
    setDraftState(value);
  };
  const [files, setFilesState] = useState(() => attachments.get(session.id) ?? []);
  const setFiles = (update: (prev: Attachment[]) => Attachment[]) =>
    setFilesState((prev) => {
      const next = update(prev);
      attachments.set(session.id, next);
      return next;
    });
  const clearFiles = () =>
    setFiles((prev) => {
      for (const f of prev) if (f.preview) URL.revokeObjectURL(f.preview);
      return [];
    });
  const uploading = files.some((f) => !f.path && !f.error);
  const ready = files.filter((f) => f.path);

  const attach = (list: File[]) => {
    for (const file of list) {
      const id = crypto.randomUUID();
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setFiles((prev) => [...prev, { id, name: file.name || 'pasted', preview, path: null, error: null }]);
      upload(file).then(
        (path) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, path } : f))),
        (err: Error) => setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, error: err.message } : f))),
      );
    }
    reply.current?.focus();
  };

  const detach = (a: Attachment) => {
    if (a.preview) URL.revokeObjectURL(a.preview);
    setFiles((prev) => prev.filter((f) => f.id !== a.id));
  };

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault();
    attach([...e.dataTransfer.files]);
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
      if ((draft.trim() || ready.length) && !uploading) e.currentTarget.form?.requestSubmit();
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
    placeholder: options.length ? 'Or write your own answer, / for commands, paste or drop files…' : 'Reply, / for commands, paste or drop files…',
    disabled: pending,
    value: draft,
    onKeyDown,
    onFocus: () => setFocused(true),
    onPaste: (e: { clipboardData: DataTransfer; preventDefault: () => void }) => {
      if (!e.clipboardData.files.length) return;
      e.preventDefault();
      attach([...e.clipboardData.files]);
    },
    onChange: (e: { currentTarget: { value: string } }) => onInput(e.currentTarget.value),
  };

  return (
    <form className={styles.form} action={submit}>
      {advice && <SecondOpinion session={session} advice={advice} onEdit={edit} />}
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
      {files.length > 0 && (
        <ul className={styles.attachments}>
          {files.map((f) => (
            <li key={f.id} data-state={f.error ? 'failed' : f.path ? 'ready' : 'uploading'} title={f.error ?? (f.path ? `Sent to Claude as ${f.path}` : 'Uploading…')}>
              {f.preview ? <img src={f.preview} alt="" /> : <span className={styles.ext}>{f.name.split('.').at(-1)?.slice(0, 4) || 'file'}</span>}
              <span className={styles.attachmentName}>{f.name}</span>
              {f.path && <input type="hidden" name="file" value={f.path} />}
              <button type="button" data-variant="ghost" aria-label={`Remove ${f.name}`} title="Remove this attachment" onClick={() => detach(f)}>×</button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.reply} onDragOver={onDragOver} onDrop={onDrop}>
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

// Its buttons act on their own: it sits inside the reply form, which forms cannot nest.
export function SecondOpinion({ session, advice: a, menu, onEdit }: { session: Session; advice: Advice; menu?: Menu; onEdit: (a: Advice) => void }) {
  const [pending, setPending] = useState(false);
  const act = async (action: string) => {
    setPending(true);
    try {
      await sessionAction(session.id, action, { key: a.key });
    } catch (err) {
      reportError(err);
    } finally {
      setPending(false);
    }
  };
  if (a.state === 'thinking') {
    return (
      <div className={styles.advice} data-state="running">
        <div className={styles.adviceHead}>
          <span className={styles.spinner} aria-hidden />
          <span title="Another model reads the code and suggests what you would likely answer">Second opinion in progress</span>
          <span><Elapsed since={a.startedAt} /></span>
          <button type="button" data-variant="ghost" disabled={pending} onClick={() => act('stop-advice')}>Stop</button>
        </div>
        <p className={styles.activity}>{a.activity ?? 'Working'}</p>
      </div>
    );
  }
  if (a.state === 'failed') {
    return (
      <div className={styles.advice} data-state="failed" title={a.error}>
        <span>{a.error === 'stopped' ? 'Second opinion stopped' : `Second opinion failed: ${a.error}`}</span>
        <button type="button" data-variant="ghost" disabled={pending} onClick={() => act('retry-advice')}>Retry</button>
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
      {menu && a.answers ? (
        <ul className={styles.adviceAnswers}>
          {menu.questions.map((q, i) => (
            <li key={q.question}><span>{q.header || q.question}</span> <strong>{a.answers![i]?.other || a.answers![i]?.labels.join(', ')}</strong></li>
          ))}
        </ul>
      ) : (
        a.choice && <strong className={styles.adviceChoice}>{a.choice}</strong>
      )}
      {a.answer && <p className={styles.adviceAnswer}>{a.answer}</p>}
      {a.reasoning && <p className={styles.adviceReason}>{a.reasoning}</p>}
      <div className={styles.adviceActions}>
        <button type="button" data-variant="primary" disabled={pending} onClick={() => act('accept-advice')}>Accept &amp; send</button>
        <button type="button" data-variant="ghost" disabled={pending} onClick={() => onEdit(a)} title={menu ? 'Pick the suggested answers below to change them first' : 'Copy the suggestion into the reply box to change it first'}>Edit</button>
      </div>
    </div>
  );
}
