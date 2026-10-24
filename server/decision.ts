import type { Menu } from './conversations.ts';
import type { Decision, QuestionOption, Session } from './db.ts';

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

// A summary is only about the latest turn when it was written from it; until the next one is,
// a decision read from an older message is stale.
export function turnDecision(s: Session): Decision | null {
  const summary = s.summary;
  if (s.question || s.status !== 'idle' || !summary?.decision || summary.question !== null || summary.basis !== s.lastTurn) return null;
  // Summaries written before options had descriptions stored bare labels.
  const options = summary.decision.options.map((o) => (typeof o === 'string' ? { label: o } : o));
  return { ...summary.decision, options };
}

const menuText = (menu: Menu) =>
  menu.questions.map((q, i) =>
    `${i + 1}. ${q.header ? `[${q.header}] ` : ''}${q.question} (${q.multiSelect ? 'pick any' : 'pick one, or write an own answer'})\n` +
    q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n')).join('\n');

// What the session waits on the developer for: a menu Claude Code opened in the terminal, an
// ask_human call, or a choice a model read from the end of Claude's last message.
export function openDecision(s: Session): OpenDecision | null {
  if (s.archived || s.status === 'exited') return null;
  if (s.menu) {
    return {
      key: `m:${s.menu.toolUseId}`, title: s.menu.questions.map((q) => q.question).join(' · '), details: menuText(s.menu),
      options: [], category: 'menu in the terminal', askedAt: s.menu.at, menu: s.menu,
    };
  }
  const q = s.question;
  if (q) return { key: `q:${q.toolUseId}`, title: q.title, details: q.details, options: q.options, category: q.category, askedAt: q.askedAt, menu: null };
  const d = turnDecision(s);
  if (!d) return null;
  return {
    key: `s:${s.summary!.basis}`, title: d.problem, details: [d.brief, d.context].filter(Boolean).join('\n\n'), options: d.options,
    category: 'end of turn', askedAt: s.summary!.at, menu: null,
  };
}
