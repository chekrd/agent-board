import type { Session } from './db.ts';
import { adviceToSend, answerText, checkDecision, claim, menuAnswerText, type AnswerStore } from './decision.ts';
import type { Keystroke } from './ghostty.ts';
import { menuKeystrokes, type MenuAnswer } from './menu.ts';

// Everything that touches the machine comes in as a dependency, so tests and the mock run this very code.
export interface AnsweringDeps {
  store: AnswerStore;
  send: (tty: string, text: string, files?: string[]) => Promise<void>;
  keys: (tty: string, strokes: Keystroke[]) => Promise<void>;
  notify: () => void;
  decided: (id: string) => void;
  isCommand: (s: Session, text: string) => Promise<boolean>;
  checkUploads: (files: unknown) => Promise<string[]>;
}

export interface Reply {
  key?: string | null;
  choice?: string;
  text?: string;
  files?: string[];
}

export function liveTty(s: Session) {
  if (s.status === 'exited') throw new Error('this session has ended; continue it first');
  if (!s.tty) throw new Error('this session has no terminal yet');
  return s.tty;
}

export function answering({ store, send, keys, notify, decided, isCommand, checkUploads }: AnsweringDeps) {
  const must = (id: string) => {
    const s = store.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  };

  // Claimed before the keys go out, which takes up to 2 s, and given back if they fail.
  async function deliver(id: string, seen: string | null | undefined, typed: boolean, text: string, type: () => Promise<void>) {
    const { reopen } = claim(store, id, seen, typed, text);
    notify();
    try {
      await type();
    } catch (err) {
      reopen();
      notify();
      throw err;
    }
    decided(id);
  }

  async function answer(id: string, reply: Reply, commands = true) {
    const text = reply.text?.trim() ?? '';
    const files = await checkUploads(reply.files);
    if (!reply.choice && !text && !files.length) throw new Error('empty answer');
    // Slash commands and `!` shell commands go in verbatim and are not an answer to the question.
    const command = commands && !reply.choice && !files.length && (await isCommand(must(id), text));
    const s = must(id);
    const tty = liveTty(s);
    if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
    if (command) return send(tty, text);
    const prompt = [s.question ? `Re: "${s.question.title}"` : '', reply.choice ? `My decision: ${reply.choice}.` : '', text].filter(Boolean).join(' — ');
    await deliver(id, reply.key, !reply.choice, answerText(reply.choice, text, files.length), () => send(tty, prompt, files));
  }

  async function answerMenu(id: string, body: { toolUseId: string; answers: MenuAnswer[] }) {
    const s = must(id);
    const tty = liveTty(s);
    const key = `m:${body.toolUseId}`;
    checkDecision(s, key);
    const strokes = menuKeystrokes(s.menu!, body.answers);
    await deliver(id, key, false, menuAnswerText(s.menu!, body.answers), () => keys(tty, strokes));
  }

  async function acceptAdvice(id: string, seenAt?: number) {
    const { advice: a, decision } = adviceToSend(must(id), seenAt);
    if (decision.menu) await answerMenu(id, { toolUseId: decision.menu.toolUseId, answers: a.answers ?? [] });
    else await answer(id, { key: a.key, choice: a.choice ?? undefined, text: a.answer }, false);
  }

  function dismiss(id: string) {
    must(id);
    decided(id);
  }

  return { answer, answerMenu, acceptAdvice, dismiss };
}
