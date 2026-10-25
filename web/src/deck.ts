import { decisionKey, menuAnswerText, openDecision } from '../../server/decision.ts';
import { compare } from './order.ts';
import type { Body, Request } from './outbox.ts';
import type { Command, MenuAnswer, Session } from './types.ts';
import { adviceFor, attentionOf, decisionOf, menuStuck, type Attention } from './util.ts';

// The queue's cards: what waits on the developer, in board order, and what each press on the card sends.

export type Kind = 'menu' | 'ask' | 'turn' | 'prompt' | 'idle';

const IN_DECK: readonly Attention[] = ['decide', 'focus', 'idle'];

// `busy` are the sessions whose send is held or not yet confirmed: they have been answered on this page.
export function deckOf(sessions: readonly Session[], busy: ReadonlySet<string>, now = Date.now()) {
  return sessions.filter((s) => !s.archived && s.status !== 'exited' && !busy.has(s.id) && IN_DECK.includes(attentionOf(s, now))).sort(compare);
}

export function kindOf(s: Session, now = Date.now()): Kind | null {
  const attention = attentionOf(s, now);
  if (attention === 'focus') return 'prompt';
  if (attention === 'idle') return 'idle';
  if (attention !== 'decide') return null;
  const key = decisionKey(s)!;
  return key.startsWith('m:') ? 'menu' : key.startsWith('q:') ? 'ask' : 'turn';
}

// The deck as it is read: the front card, then a send that failed until it has been at the front, then the rest in
// board order from the front on, round to the start.
export function rotate<T extends { id: string }>(deck: readonly T[], frontId: string | null, notSent: ReadonlySet<string> = new Set()) {
  const at = Math.max(0, deck.findIndex((s) => s.id === frontId));
  const [front, ...rest] = [...deck.slice(at), ...deck.slice(0, at)];
  return front ? [front, ...rest.filter((s) => notSent.has(s.id)), ...rest.filter((s) => !notSent.has(s.id))] : [];
}

// The card that followed the one leaving in the order the page last showed, passing over cards that left too.
export function successor(lastOrder: readonly string[], leavingId: string, deck: readonly { id: string }[]) {
  const ids = new Set(deck.map((s) => s.id));
  const from = lastOrder.indexOf(leavingId);
  for (let i = 1; i <= lastOrder.length; i++) {
    const id = lastOrder[(from + i) % lastOrder.length];
    if (id !== leavingId && ids.has(id)) return id;
  }
  return deck[0]?.id ?? null;
}

// The card pinned by id stays at the front for as long as it is in the deck; an arrival never takes its place.
export function resolveFront(deck: readonly { id: string }[], pinned: string | null, lastOrder: readonly string[]) {
  if (pinned && deck.some((s) => s.id === pinned)) return pinned;
  return pinned ? successor(lastOrder, pinned, deck) : (deck[0]?.id ?? null);
}

// Decisions that came in after the page loaded and have not been at the front yet, newest first. A new decision on
// the front card itself is an update of the card being read, not an arrival.
export function arrivals(deck: readonly Session[], seen: ReadonlySet<string>, frontId: string | null, now = Date.now()) {
  return deck
    .filter((s) => s.id !== frontId && attentionOf(s, now) === 'decide' && !seen.has(decisionKey(s)!))
    .sort((a, b) => openDecision(b)!.askedAt - openDecision(a)!.askedAt);
}

export const METER_SEGMENTS = 20;

export interface Segment {
  id: string;
  attention: Attention;
  current: boolean;
  arrived: boolean;
}

export interface Bar {
  attention: Attention;
  count: number;
  current: boolean;
  arrived: boolean;
  // Where a click goes: the group's first card, or the next one when the front card is in the group.
  target: string;
}

const GROUPS = [['decide', 'decision', 'decisions'], ['focus', 'terminal prompt', 'terminal prompts'], ['idle', 'finished turn', 'finished turns']] as const;

// One segment per card up to 20, then one bar per attention group with its count. `label` reads
// "3 decisions · 1 terminal prompt · 2 finished turns"; `position` is the front card's place, 1-based, or 0.
export function meter(deck: readonly Session[], frontId: string | null, arrived: ReadonlySet<string> = new Set(), now = Date.now()) {
  const attention = deck.map((s) => attentionOf(s, now));
  const label = GROUPS.flatMap(([a, one, many]) => {
    const n = attention.filter((x) => x === a).length;
    return n ? [`${n} ${n === 1 ? one : many}`] : [];
  }).join(' · ');
  const position = deck.findIndex((s) => s.id === frontId) + 1;
  if (deck.length <= METER_SEGMENTS) {
    const segments: Segment[] = deck.map((s, i) => ({ id: s.id, attention: attention[i], current: s.id === frontId, arrived: arrived.has(s.id) }));
    return { label, position, total: deck.length, segments, bars: null };
  }
  const bars: Bar[] = GROUPS.flatMap(([a]) => {
    const ids = deck.filter((_, i) => attention[i] === a).map((s) => s.id);
    if (!ids.length) return [];
    const at = frontId === null ? -1 : ids.indexOf(frontId);
    return [{ attention: a, count: ids.length, current: at >= 0, arrived: ids.some((id) => arrived.has(id)), target: ids[(at + 1) % ids.length] }];
  });
  return { label, position, total: deck.length, segments: null, bars };
}

// What ⏎ and the primary button send, fixed when the card is first shown so that advice finishing or changing
// while it is read never changes what ⏎ sends. `late` marks a suggestion that filled a frozen nothing.
export type Frozen =
  | { via: 'advice'; label: string | null; adviceAt: number; late?: true }
  | { via: 'recommended'; label: string }
  | { via: 'none'; label: null }
  | { via: 'menu'; picks: MenuAnswer[]; adviceAt: number | null };

const noPicks = (s: Session) => s.menu!.questions.map(() => ({ labels: [], other: '' }));

export function freeze(s: Session): Frozen | null {
  const key = decisionKey(s);
  const a = adviceFor(s);
  const done = a?.state === 'done' ? a : null;
  if (key?.startsWith('m:')) {
    const answers = done?.answers?.length === s.menu!.questions.length ? done.answers : null;
    return { via: 'menu', picks: answers?.map((x) => ({ labels: [...x.labels], other: x.other ?? '' })) ?? noPicks(s), adviceAt: answers ? done!.at : null };
  }
  const d = decisionOf(s);
  if (!d) return null;
  if (done) return { via: 'advice', label: d.options.some((o) => o.label === done.choice) ? done.choice : null, adviceAt: done.at };
  const recommended = d.options.find((o) => o.recommended);
  return recommended ? { via: 'recommended', label: recommended.label } : { via: 'none', label: null };
}

// A later snapshot changes a frozen choice in two cases only: a second opinion that finishes fills a frozen
// nothing, and a rewrite of the decision that drops the frozen option starts it over, as an update.
export function refreeze(frozen: Frozen, s: Session): { frozen: Frozen; why: 'suggestion' | 'rewritten' } | null {
  if (frozen.via === 'menu') return null;
  const fresh = freeze(s);
  const d = decisionOf(s);
  if (!fresh || !d || fresh.via === 'menu') return null;
  if (frozen.label !== null && !d.options.some((o) => o.label === frozen.label)) return { frozen: fresh, why: 'rewritten' };
  if (frozen.via === 'none' && fresh.via === 'advice') return { frozen: { ...fresh, late: true }, why: 'suggestion' };
  return null;
}

export interface Composer {
  open: boolean;
  text: string;
  // Attachments that finished uploading.
  files: readonly string[];
  uploading?: boolean;
}

export type Intent = { intent: 'compose' } | { intent: 'terminal' };

export interface Primary {
  label: string;
  disabled: boolean;
  press: Request | Intent | null;
}

const reply: Primary = { label: 'Reply', disabled: false, press: { intent: 'compose' } };

// The draft and the ready files go along with an option only while the composer is open, so nothing unseen is sent.
function noteOf(composer: Composer | undefined): Body | null {
  if (!composer?.open) return null;
  const text = composer.text.trim();
  if (!text && !composer.files.length) return null;
  const note: Body = {};
  if (text) note.text = text;
  if (composer.files.length) note.files = [...composer.files];
  return note;
}

const samePicks = (a: readonly MenuAnswer[], b: readonly MenuAnswer[] | undefined) =>
  !!b && a.length === b.length && a.every((p, i) =>
    p.other.trim() === (b[i].other ?? '').trim() && p.labels.length === b[i].labels.length && p.labels.every((l) => b[i].labels.includes(l)));

export function menuAnswer(s: Session, picks: readonly MenuAnswer[]): Request {
  const answers = picks.map((p) => ({ labels: [...p.labels], other: p.other }));
  return { action: 'answer-menu', body: { toolUseId: s.menu!.toolUseId, answers }, label: menuAnswerText(s.menu!, answers) };
}

function menuPrimary(s: Session, picks: readonly MenuAnswer[]): Primary {
  const questions = s.menu!.questions;
  if (!questions.every((_, i) => picks[i]?.labels.length || picks[i]?.other.trim())) {
    const label = questions.length === 1 ? 'Pick an option' : questions.length === 2 ? 'Answer both questions' : 'Answer every question';
    return { label, disabled: true, press: null };
  }
  const a = adviceFor(s);
  return { label: a?.state === 'done' && samePicks(picks, a.answers) ? 'Accept suggestion' : 'Send answer', disabled: false, press: menuAnswer(s, picks) };
}

// The footer's primary button, which ⏎ presses: the frozen choice (with the open composer's note), the picks of a
// menu, Terminal, or Reply. It never sends the composer's text by itself; Enter in the composer does that.
export function primary(s: Session, frozen: Frozen | null, input: { composer?: Composer; picks?: readonly MenuAnswer[] } = {}, now = Date.now()): Primary {
  const kind = kindOf(s, now);
  if (kind === 'prompt') return { label: 'Terminal', disabled: false, press: { intent: 'terminal' } };
  if (kind !== 'menu' && kind !== 'ask' && kind !== 'turn') return { ...reply, disabled: kind !== 'idle' };
  const f = frozen ?? freeze(s)!;
  if (kind === 'menu') return menuPrimary(s, input.picks ?? (f.via === 'menu' ? f.picks : noPicks(s)));
  if (f.via === 'menu') return reply;
  const key = decisionKey(s)!;
  const a = adviceFor(s);
  const unchanged = f.via === 'advice' && a?.state === 'done' && a.at === f.adviceAt;
  const note = noteOf(input.composer);
  if (f.via === 'advice' && f.label === null) {
    return unchanged ? { label: 'Accept suggestion', disabled: false, press: { action: 'accept-advice', body: { key, adviceAt: f.adviceAt }, label: a!.answer } } : reply;
  }
  if (f.label === null) return decisionOf(s)!.options.length ? { label: 'Pick an option', disabled: true, press: null } : reply;
  if (unchanged && !note) return { label: 'Accept suggestion', disabled: false, press: { action: 'accept-advice', body: { key, adviceAt: f.adviceAt }, label: f.label } };
  return {
    label: note ? `Send “${f.label}” + your note` : `Send “${f.label}”`,
    disabled: !!note && !!input.composer?.uploading,
    press: { action: 'answer', body: { key, choice: f.label, ...note }, label: f.label },
  };
}

// What ⏎ would send without the note. The key guard restarts when this changes under the reader.
export function targetOf(s: Session, frozen: Frozen | null, now = Date.now()) {
  const { press } = primary(s, frozen, {}, now);
  if (!press) return 'none';
  if ('intent' in press) return press.intent;
  return press.action === 'accept-advice' ? `accept:${press.body.adviceAt}` : press.action === 'answer' ? `choice:${press.body.choice}` : press.action;
}

// An option pressed on an ask or end-of-turn card: the second opinion's own option accepts it, as long as no note
// goes with it.
export function choose(s: Session, label: string, composer?: Composer): Request {
  const key = decisionKey(s)!;
  const a = adviceFor(s);
  const note = noteOf(composer);
  if (a?.state === 'done' && a.choice === label && !note) return { action: 'accept-advice', body: { key, adviceAt: a.at }, label };
  return { action: 'answer', body: { key, choice: label, ...note }, label };
}

// As the server tells a command from an answer: a `!` line, or a `/name` from its command list. Until that list has
// loaded nothing counts, so no answer is mistaken for a command that keeps its card and skips the early check.
export function isCommand(text: string, files: number, commands: readonly Command[] | null) {
  if (files || !commands) return false;
  if (text.startsWith('!')) return true;
  const name = text.match(/^\/(\S+)/)?.[1];
  return !!name && commands.some((c) => c.name === name);
}

// What Enter in a composer sends: an answer to the card's decision (`key`), or a plain message (null).
export function typed(key: string | null, text: string, files: readonly string[], commands: readonly Command[] | null): Request {
  const t = text.trim();
  if (isCommand(t, files.length, commands)) return { action: 'answer', body: { key, text: t }, label: t, command: true };
  const body: Body = { key };
  if (t) body.text = t;
  if (files.length) body.files = [...files];
  return { action: 'answer', body, label: t || (files.length === 1 ? '1 file' : `${files.length} files`) };
}

export function dismissal(s: Session): Request {
  const d = decisionOf(s)!;
  return { action: 'dismiss', body: { key: d.key }, label: d.problem };
}

// The Needs-focus card: what the terminal shows, and its subject when Claude names one ("… for Bash: pnpm test").
export function promptOf(s: Session, now = Date.now()) {
  if (menuStuck(s, now)) return { headline: 'Claude still shows its menu in the terminal', subject: null };
  const waiting = s.waitingFor ?? 'a prompt';
  const at = waiting.indexOf(' for ');
  return { headline: `Claude is showing ${waiting} in its terminal`, subject: at > 0 ? waiting.slice(at + 5) : null };
}
