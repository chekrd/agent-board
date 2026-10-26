import type { Menu } from './conversations.ts';
import type { Answered, Decision, QuestionOption, Session } from './db.ts';
import type { MenuAnswer } from './menu.ts';

// Also imported by the UI, so only type imports here.

export interface OpenDecision {
  key: string;
  title: string;
  details: string;
  options: QuestionOption[];
  category: string;
  askedAt: number;
  menu: Menu | null;
}

export class Refusal extends Error {
  code: 'stale' | 'answered' | 'out-of-date' | 'advice-changed';
  constructor(message: string, code: Refusal['code']) {
    super(message);
    this.code = code;
  }
}

// A summary is only about the latest turn when it was written from it; until the next one is,
// a decision read from an older message is stale.
export function turnDecision(s: Session): Decision | null {
  const summary = s.summary;
  if (s.question || s.status !== 'idle' || !summary?.decision || summary.question !== null || summary.basis !== s.lastTurn) return null;
  // Summaries written before options had descriptions stored bare labels.
  const options = summary.decision.options.map((o) => (typeof o === 'string' ? { label: o } : o));
  return { ...summary.decision, options };
}

// The decision the task page shows. Unlike openDecision, archived and ended sessions keep theirs. One the board
// answered is closed at once, before the terminal or the transcript catch up.
export const decisionKey = (s: Session) => {
  const key = s.menu ? `m:${s.menu.toolUseId}` : s.question ? `q:${s.question.toolUseId}` : turnDecision(s) ? `s:${s.summary!.basis}` : null;
  return key === s.answered?.key ? null : key;
};

// `seen` is the decision the page showed, null for none; a page built before this check sends nothing and
// reloads once it reconnects. A typed reply may also meet a decision read from the end of the turn: that is
// read from the very message the developer was answering, and the reply is sent the same either way.
export function checkDecision(s: Session, seen: string | null | undefined, typed = false) {
  if (seen === undefined) throw new Refusal('this page is out of date; reload it', 'out-of-date');
  const open = decisionKey(s);
  if (seen === open || (typed && seen === null && open?.startsWith('s:'))) return;
  if (seen !== null && seen === s.answered?.key) throw new Refusal('you already answered this', 'answered');
  throw new Refusal(seen === null ? 'Claude has asked something meanwhile; read it first' : 'this question is no longer open', 'stale');
}

export interface AnswerStore {
  get(id: string): Session | undefined;
  update(id: string, patch: { answered: Answered | null }): void;
}

// Reads, checks and closes in one synchronous step, so a second request for the same decision finds it answered
// even while the first is still typing; a plain message keeps the decision an earlier answer closed. reopen()
// gives it back unless a later send has claimed since.
export function claim(store: AnswerStore, id: string, seen: string | null | undefined, typed: boolean, text: string) {
  const s = store.get(id);
  if (!s) throw new Error(`unknown session ${id}`);
  checkDecision(s, seen, typed);
  const before = s.answered ?? null;
  // Later than the record it replaces, so reopen() can tell the two apart.
  const at = Math.max(Date.now(), (before?.at ?? 0) + 1);
  const answered: Answered = { key: decisionKey(s) ?? before?.key ?? null, text: text.slice(0, 500), at };
  store.update(id, { answered });
  const reopen = () => {
    const now = store.get(id)?.answered;
    if (now?.at === answered.at && now.key === answered.key && now.text === answered.text) store.update(id, { answered: before });
  };
  return { s, reopen };
}

const menuText = (menu: Menu) =>
  menu.questions.map((q, i) =>
    `${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question} (${q.multiSelect ? 'pick any' : 'pick one, or write an own answer'})\n` +
    q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')).join('\n');

// What the session waits on the developer for: a menu Claude Code opened in the terminal, an
// ask_human call, or a choice a model read from the end of Claude's last message.
export function openDecision(s: Session): OpenDecision | null {
  const key = decisionKey(s);
  if (!key || s.archived || s.status === 'exited') return null;
  if (s.menu) {
    return {
      key, title: s.menu.questions.map((q) => q.question).join(' · '), details: menuText(s.menu),
      options: [], category: 'menu in the terminal', askedAt: s.menu.at, menu: s.menu,
    };
  }
  const q = s.question;
  if (q) return { key, title: q.title, details: q.details, options: q.options, category: q.category, askedAt: q.askedAt, menu: null };
  const d = turnDecision(s)!;
  return {
    key, title: d.problem, details: [d.brief, d.context].filter(Boolean).join('\n\n'), options: d.options,
    category: 'end of turn', askedAt: s.summary!.at, menu: null,
  };
}

// The second opinion the page showed, named by its `at`; a page that sends none skips that check.
export function adviceToSend(s: Session, seenAt?: number) {
  const a = s.advice;
  const decision = openDecision(s);
  if (a?.state !== 'done' || !decision || a.key !== decision.key) throw new Refusal('no advice to accept', 'stale');
  if (seenAt !== undefined && a.at !== seenAt) throw new Refusal('the second opinion changed; read it again', 'advice-changed');
  return { advice: a, decision };
}

// The advisor's reply often starts with the option it picked.
export function answerText(choice: string | undefined, text: string, files: number) {
  const said = !choice ? text : !text ? choice : text.startsWith(choice) ? text : `${choice} — ${text}`;
  return files ? `${said} (+${files} ${files === 1 ? 'file' : 'files'})`.trimStart() : said;
}

export const menuAnswerText = (menu: Menu, answers: MenuAnswer[]) =>
  menu.questions.map((q, i) => `${q.header || q.question}: ${answers[i]?.other?.replace(/\s+/g, ' ').trim() || answers[i]?.labels.join(', ')}`).join(' · ');

const PROMPT_LAG_MS = 30_000;

// An answer to a question starts the next turn, whose prompt reaches the transcript a moment later; a menu
// answer continues the current turn. A turn started later from the terminal is not about this answer.
export function answeredLine(s: Session) {
  const a = s.answered;
  if (!a) return null;
  return (s.activity?.since ?? a.at) <= a.at + PROMPT_LAG_MS ? a.text : null;
}
