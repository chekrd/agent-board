import { useEffect, useRef, useState, useSyncExternalStore, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import { api, upload } from '../api.ts';
import { typed } from '../deck.ts';
import type { Request } from '../outbox.ts';
import type { Command, Session } from '../types.ts';
import styles from './Composer.module.css';
import { Icon } from './Icon.tsx';

export interface Attachment {
  id: string;
  name: string;
  preview: string | null;
  path: string | null;
  error: string | null;
}

export interface Draft {
  text: string;
  files: readonly Attachment[];
}

const STORED = 'agent-board:drafts';
const EMPTY: Draft = { text: '', files: [] };

type Kept = [string, { text: string; files: { name: string; path: string }[] }][];

function stored(): [string, Draft][] {
  try {
    const kept = JSON.parse(sessionStorage.getItem(STORED) ?? '[]') as Kept;
    return kept.map(([id, d]) => [id, { text: d.text, files: d.files.map((f) => ({ id: crypto.randomUUID(), name: f.name, path: f.path, preview: null, error: null })) }]);
  } catch {
    return [];
  }
}

// A draft and its attachments belong to the session, not to the card on screen, and a reload keeps the text and the
// files that finished uploading.
let drafts = new Map<string, Draft>(stored());
const subscribers = new Set<() => void>();

function save() {
  const kept: Kept = [...drafts].flatMap(([id, d]): Kept => {
    const files = d.files.flatMap((f) => (f.path ? [{ name: f.name, path: f.path }] : []));
    return d.text || files.length ? [[id, { text: d.text, files }]] : [];
  });
  try {
    sessionStorage.setItem(STORED, JSON.stringify(kept));
  } catch {
    // A page without storage keeps them in memory only.
  }
}

export const draftOf = (id: string) => drafts.get(id) ?? EMPTY;

export function editDraft(id: string, edit: (d: Draft) => Draft) {
  drafts = new Map(drafts).set(id, edit(draftOf(id)));
  save();
  for (const fn of subscribers) fn();
}

// A send takes the text and the files that finished uploading; one still uploading stays, and one that failed goes.
export function takeDraft(id: string): Draft | null {
  const d = draftOf(id);
  const ready = d.files.filter((f) => f.path);
  if (!d.text && !ready.length) return null;
  release({ text: '', files: d.files.filter((f) => f.error) });
  editDraft(id, () => ({ text: '', files: d.files.filter((f) => !f.path && !f.error) }));
  return { text: d.text, files: ready };
}

// A send taken back or refused gives back what it took, ahead of anything written since.
export function putBack(id: string, sent: Draft) {
  editDraft(id, (d) => ({ text: [sent.text, d.text].filter(Boolean).join('\n\n'), files: [...sent.files, ...d.files] }));
}

export function release(d: Draft) {
  for (const f of d.files) if (f.preview) URL.revokeObjectURL(f.preview);
}

const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => void subscribers.delete(fn);
};

export const useDraft = (id: string) => useSyncExternalStore(subscribe, () => draftOf(id));

const COMMANDS_FRESH_MS = 60_000;
const commandCache = new Map<string, { at: number; list: Promise<Command[]> }>();

// The session's commands and skills, asked for once the field has focus or a draft starts with "/"; null until they
// have loaded, so nothing counts as a command before the list says so.
export function useCommands(worktree: string, wanted: boolean) {
  const [commands, setCommands] = useState<Command[] | null>(null);
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

export function rank(commands: readonly Command[], query: string) {
  const score = (c: Command) => {
    const name = c.name.toLowerCase();
    if (name === query) return -1;
    if (name.startsWith(query)) return 0;
    if (name.split(':').at(-1)!.startsWith(query)) return 1;
    return name.includes(query) ? 2 : 3;
  };
  return commands.map((c) => ({ c, s: score(c) })).filter((x) => x.s < 3).sort((a, b) => a.s - b.s).slice(0, 8).map((x) => x.c);
}

export const uploading = (d: Draft) => d.files.some((f) => !f.path && !f.error);
export const readyPaths = (d: Draft) => d.files.flatMap((f) => (f.path ? [f.path] : []));

export function attach(id: string, list: readonly File[]) {
  for (const file of list) {
    const a: Attachment = { id: crypto.randomUUID(), name: file.name || 'pasted', preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : null, path: null, error: null };
    editDraft(id, (d) => ({ ...d, files: [...d.files, a] }));
    const settle = (patch: Partial<Attachment>) => editDraft(id, (d) => ({ ...d, files: d.files.map((f) => (f.id === a.id ? { ...f, ...patch } : f)) }));
    upload(file).then((path) => settle({ path }), (err: Error) => settle({ error: err.message }));
  }
}

function detach(id: string, a: Attachment) {
  release({ text: '', files: [a] });
  editDraft(id, (d) => ({ ...d, files: d.files.filter((f) => f.id !== a.id) }));
}

const files = (e: { dataTransfer?: DataTransfer | null; clipboardData?: DataTransfer | null }) => [...((e.dataTransfer ?? e.clipboardData)?.files ?? [])];

export interface ComposerProps {
  session: Session;
  // The key of the decision the card shows, which Enter answers; null for a plain message.
  decision: string | null;
  label: string;
  placeholder: string;
  // A new value asks for focus.
  focus: number;
  note?: string | null;
  onSend: (request: Request) => void;
  onEscape: () => void;
}

// The reply box: Enter sends, Shift+Enter adds a line, "/" lists the session's commands, and files come by paste,
// drop or the paperclip. Esc closes the command list first, then leaves the box.
export function Composer({ session, decision, label, placeholder, focus, note, onSend, onEscape }: ComposerProps) {
  const id = session.id;
  const draft = useDraft(id);
  const field = useRef<HTMLTextAreaElement>(null);
  const section = useRef<HTMLElement>(null);
  const [picked, setPicked] = useState(0);
  const [closed, setClosed] = useState(false);
  const [focused, setFocused] = useState(false);
  const commands = useCommands(session.worktree, focused || draft.text.startsWith('/'));
  const query = /^\/\S*$/.test(draft.text) && !closed ? draft.text.slice(1).toLowerCase() : null;
  const matches = query === null || !commands ? [] : rank(commands, query);
  const listed = matches.length > 0;

  // The whole box comes into view, its hint line under the field included.
  useEffect(() => {
    if (!focus) return;
    field.current?.focus();
    section.current?.scrollIntoView({ block: 'nearest' });
  }, [focus]);

  useEffect(() => {
    if (listed) section.current?.scrollIntoView({ block: 'nearest' });
  }, [listed]);

  const setText = (text: string) => editDraft(id, (d) => ({ ...d, text }));

  const complete = (c: Command) => {
    setText(`/${c.name} `);
    setClosed(true);
    field.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const exact = matches.some((c) => `/${c.name}` === draft.text);
    if (listed && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setPicked((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
    } else if (listed && e.key === 'Escape') {
      e.preventDefault();
      setClosed(true);
    } else if (listed && (e.key === 'Tab' || (e.key === 'Enter' && !exact))) {
      e.preventDefault();
      complete(matches[picked % matches.length]);
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const ready = readyPaths(draft);
      if ((draft.text.trim() || ready.length) && !uploading(draft)) onSend(typed(decision, draft.text, ready, commands));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onEscape();
    }
  };

  const onInput = (value: string) => {
    setText(value);
    setPicked(0);
    setClosed(value.startsWith('/') && /\s/.test(value));
  };

  const onPaste = (e: ClipboardEvent) => {
    if (!files(e).length) return;
    e.preventDefault();
    attach(id, files(e));
  };
  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault();
  };
  const onDrop = (e: DragEvent) => {
    if (!files(e).length) return;
    e.preventDefault();
    attach(id, files(e));
    field.current?.focus();
  };

  return (
    <section ref={section} className={styles.composer} aria-label={label} onDragOver={onDragOver} onDrop={onDrop}>
      <div className={styles.head}>
        <h3 className={styles.label}>{label}</h3>
        {note && <span className={styles.note} role="status">{note}</span>}
      </div>
      {listed && (
        <div className={styles.commands} role="listbox" aria-label="Commands and skills">
          {matches.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={i === picked % matches.length}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(c);
              }}
            >
              <code>/{c.name}</code>
              <span>{c.description}</span>
            </button>
          ))}
        </div>
      )}
      {draft.files.length > 0 && (
        <div className={styles.files}>
          {draft.files.map((f) => (
            <span
              key={f.id}
              className={styles.file}
              data-state={f.error ? 'failed' : f.path ? 'ready' : 'uploading'}
              title={f.error ? `Could not upload: ${f.error}` : f.path ? `Sent to Claude as ${f.path}` : 'Uploading…'}
            >
              {f.preview ? <span className={styles.thumb} style={{ backgroundImage: `url("${f.preview}")` }} aria-hidden /> : <span className={styles.ext}>{f.name.split('.').at(-1)?.slice(0, 4) || 'file'}</span>}
              <span className={styles.name}>{f.name}</span>
              {!f.path && !f.error && <span className={styles.spinner} aria-hidden />}
              {f.error && <span className={styles.failed}>failed</span>}
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => {
                  detach(id, f);
                  field.current?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className={styles.box}>
        <textarea
          ref={field}
          rows={1}
          aria-label={label}
          placeholder={placeholder}
          value={draft.text}
          onChange={(e) => onInput(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
        />
        <label className={styles.attach} title="Attach files; pasting or dropping them works too">
          {/* The chooser leaves focus on the input, picked or cancelled; React has no onCancel for an input. */}
          <input
            ref={(input) => {
              const back = () => field.current?.focus();
              input?.addEventListener('cancel', back);
              return () => input?.removeEventListener('cancel', back);
            }}
            type="file"
            multiple
            aria-label="Attach files"
            onChange={(e) => {
              attach(id, [...(e.currentTarget.files ?? [])]);
              e.currentTarget.value = '';
              field.current?.focus();
            }}
          />
          <Icon name="paperclip" size={18} />
        </label>
      </div>
      <p className={styles.hint}>Enter sends · Shift+Enter adds a line · / and ! go to the terminal as typed</p>
    </section>
  );
}
