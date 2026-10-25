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

interface Typing {
  claim?: { seen: string | null | undefined; typed: boolean; text: string };
  type: () => Promise<void>;
}

export function liveTty(s: Session) {
  if (s.status === 'exited') throw new Error('this session has ended; continue it first');
  if (!s.tty) throw new Error('this session has no terminal yet');
  return s.tty;
}

// Text typed while Claude shows a permission prompt or a menu would answer that instead.
function promptTty(s: Session) {
  const tty = liveTty(s);
  if (s.status === 'waiting' || s.menu) throw new Error(`Claude is showing ${s.waitingFor ?? 'a question'} in its terminal; answer that first`);
  return tty;
}

export function answering({ store, send, keys, notify, decided, isCommand, checkUploads }: AnsweringDeps) {
  const turns = new Map<string, Promise<void>>();

  const must = (id: string) => {
    const s = store.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  };

  // Claimed before the keys go out, which takes up to 2 s, and given back if they fail.
  async function deliver(id: string, t: Typing) {
    if (!t.claim) return t.type();
    const { reopen } = claim(store, id, t.claim.seen, t.claim.typed, t.claim.text);
    notify();
    try {
      await t.type();
    } catch (err) {
      reopen();
      notify();
      throw err;
    }
    decided(id);
  }

  // One send at a time per session, since a paste that lands in another's pause before Enter joins its prompt. A send
  // that had to wait is checked again, so it meets the decision as the one before left it: closed if that went out,
  // open again if it failed.
  async function inTurn(id: string, prepare: () => Typing) {
    let next = prepare();
    for (let turn = turns.get(id); turn; turn = turns.get(id)) {
      await turn;
      next = prepare();
    }
    const done = deliver(id, next);
    const free = () => void turns.delete(id);
    turns.set(id, done.then(free, free));
    return done;
  }

  async function answer(id: string, reply: Reply, commands = true) {
    const text = reply.text?.trim() ?? '';
    const files = await checkUploads(reply.files);
    if (!reply.choice && !text && !files.length) throw new Error('empty answer');
    // Slash commands and `!` shell commands go in verbatim and are not an answer to the question.
    const command = commands && !reply.choice && !files.length && (await isCommand(must(id), text));
    await inTurn(id, () => {
      const s = must(id);
      const tty = promptTty(s);
      if (command) return { type: () => send(tty, text) };
      checkDecision(s, reply.key, !reply.choice);
      const about = s.question && reply.key === `q:${s.question.toolUseId}` ? `Re: "${s.question.title}"` : '';
      const prompt = [about, reply.choice ? `My decision: ${reply.choice}.` : '', text].filter(Boolean).join(' — ');
      return { claim: { seen: reply.key, typed: !reply.choice, text: answerText(reply.choice, text, files.length) }, type: () => send(tty, prompt, files) };
    });
  }

  async function answerMenu(id: string, body: { toolUseId: string; answers: MenuAnswer[] }) {
    await inTurn(id, () => {
      const s = must(id);
      const tty = liveTty(s);
      const key = `m:${body.toolUseId}`;
      checkDecision(s, key);
      const strokes = menuKeystrokes(s.menu!, body.answers);
      return { claim: { seen: key, typed: false, text: menuAnswerText(s.menu!, body.answers) }, type: () => keys(tty, strokes) };
    });
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

  // For typing that answers nothing, such as a /rename: it takes its turn too, so it never lands inside another send.
  async function type(id: string, text: string) {
    await inTurn(id, () => {
      const tty = promptTty(must(id));
      return { type: () => send(tty, text) };
    });
  }

  return { answer, answerMenu, acceptAdvice, dismiss, type };
}
