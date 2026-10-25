import type { Session } from '../../server/db.ts';
import type { RepoView } from '../../server/workspace.ts';
import { addFromTemplate, queue, repos, ROOTS, session, titleOf, type Template } from './fixtures.ts';

// Behaviour the real server shows only when something goes wrong.
export type Flag = 'explainFails' | 'lossFails';

export interface Scenario {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  flags: Record<string, Flag[]>;
}

const MIN = 60_000;

const base = (now: number, sessions: Session[]): Scenario => ({
  roots: ROOTS, repos: repos(now), sessions, flags: { 's-group': ['explainFails'], 's-stripe': ['lossFails'] },
});

const withSession = (sessions: Session[], id: string, patch: Partial<Session>) => sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));

const kindOf = (s: Session) =>
  s.archived ? 'archived' : s.menu || s.question || s.summary?.decision ? 'decide' : s.status === 'waiting' ? 'prompt' : s.status;

const DECIDING = ['ask', 'turn', 'menu'] as const;

// The queue's sessions, then made-up ones until each kind has its count. Made-up decisions take turns being an
// ask_human question, an end-of-turn decision and a menu; every seventh is unranked.
function crowd(now: number, counts: { decide: number; prompt: number; idle: number; working: number; exited: number }): Scenario {
  const scenario = base(now, []);
  const known = queue(now);
  let made = 0;
  const make = (template: Template, rank: number | null) => {
    const repo = scenario.repos[made % scenario.repos.length];
    scenario.sessions.push(addFromTemplate(repo, template, { id: `v-${String(made + 1).padStart(2, '0')}`, title: titleOf(made), now: now - made * MIN, rank }));
    made++;
  };
  for (const [kind, count] of Object.entries(counts)) {
    const kept = known.filter((s) => kindOf(s) === kind).slice(0, count);
    scenario.sessions.push(...kept);
    for (let i = kept.length; i < count; i++) {
      if (kind === 'decide') make(DECIDING[i % DECIDING.length], i % 7 === 6 ? null : i + 1);
      else make(kind as Template, null);
    }
  }
  return scenario;
}

export const scenarios: Record<string, (now: number) => Scenario> = {
  // 3 decisions, 1 Needs focus, 2 Your turn, 3 working, 2 ended, 1 archived.
  queue: (now) => base(now, queue(now)),

  freeze: (now) => base(now, withSession(queue(now), 's-cart', {
    advice: {
      key: 'q:toolu_01Cart', state: 'thinking', startedAt: now - 20_000, at: now - 20_000, activity: 'Read src/cart/CartService.ts',
      choice: null, answer: '', confidence: 0, reasoning: '',
    },
  })),

  freetext: (now) => base(now, [...queue(now), session({
    id: 's-flag', repoId: 1, worktree: '~/code/worktrees/guest-cart-merge/storefront', tty: '/dev/ttys015', pid: 81240,
    title: 'Name the cart-merge feature flag', firstPrompt: 'Put the guest cart merge behind a feature flag.',
    status: 'idle', createdAt: now - 20 * MIN, updatedAt: now - 2 * MIN, rank: 4, rankReason: 'A name only; nothing else waits on it',
    question: {
      toolUseId: 'toolu_01Flag', category: 'plan-problem', askedAt: now - 2 * MIN, title: 'What should the feature flag be called?',
      details: 'The flag guards the new merge in `onLogin`. The other checkout flags are named `checkout.<feature>`.', options: [],
    },
    summary: {
      text: 'The merge is behind a flag; Claude asks for its name.', progress: ['Wrapped mergeCarts() in a flag check'], learnings: [],
      decision: { problem: 'What should the feature flag be called?', brief: 'The other checkout flags are named checkout.<feature>.', context: '', options: [] },
      question: 'toolu_01Flag', basis: 't-flag-2', at: now - 2 * MIN,
    },
    advice: {
      key: 'q:toolu_01Flag', state: 'done', startedAt: now - 2 * MIN, at: now - MIN, activity: null, choice: null, confidence: 77,
      answer: 'Call it `checkout.mergeGuestCart`, like the other checkout flags.', reasoning: 'Every flag in config/flags.ts follows checkout.<feature>.',
    },
    lastMessage: 'The merge is behind a flag now. What should the flag be called?', lastTurn: 't-flag-2',
  })]),

  'lone-menu': (now) => base(now, [
    ...queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived)),
    session({
      id: 's-lone', repoId: 2, worktree: '~/code/worktrees/webhook-retries/billing-api', tty: '/dev/ttys009', pid: 78120,
      title: 'Retry failed webhooks', firstPrompt: 'Webhook deliveries that fail are never retried (BILL-88). Add retries with backoff.',
      status: 'waiting', createdAt: now - 2 * 60 * MIN, updatedAt: now - 3 * MIN, rank: 1, rankReason: 'One quick question',
      menu: {
        toolUseId: 'toolu_01Lone', at: now - 3 * MIN,
        questions: [{
          header: 'Backoff', question: 'Which retry schedule should failed webhook deliveries use?', multiSelect: false,
          options: [
            { label: 'Exponential, 5 tries', description: '1 min, 5 min, 25 min, 2 h, 10 h' },
            { label: 'Every 15 min, 8 tries', description: 'Even load on receivers; gives up after 2 h' },
            { label: 'Linear, 6 tries', description: '10, 20, 30, 40, 50, 60 min' },
          ],
        }],
      },
      lastMessage: 'The retry worker is done. I asked in the terminal which schedule to use.', lastTurn: 't-lone-2',
    }),
  ]),

  long: (now) => base(now, queue(now).map((s) => (s.id !== 's-cart' || !s.question ? s : {
    ...s,
    question: {
      ...s.question,
      details: Array(4).fill(s.question.details).join('\n\n'),
      options: [
        ...s.question.options,
        { label: 'Merge, newest wins', description: 'Take the cart that changed last when both have the same product' },
        { label: 'Merge without caps', description: 'Add up quantities and let checkout reject what is out of stock' },
        { label: 'Keep the guest cart', description: 'Replace the account cart with the guest cart' },
        { label: 'Save the guest cart for later', description: 'Keep the account cart and move guest items to a saved list' },
        { label: 'Decide per product', description: 'A dialog lists each conflicting product with both quantities' },
      ],
    },
  }))),

  'ended-question': (now) => base(now, [...queue(now), session({
    id: 's-gone', repoId: 4, worktree: '~/code/worktrees/fix-anchors/docs-site',
    title: 'Rotate the docs signing key', firstPrompt: 'Rotate the key that signs the docs deploys.',
    status: 'exited', createdAt: now - 4 * 60 * MIN, updatedAt: now - 60 * MIN,
    question: {
      toolUseId: 'toolu_01Gone', category: 'plan-problem', askedAt: now - 70 * MIN, title: 'Revoke the old key right away?',
      details: 'Deploys signed with the old key would stop verifying at once.',
      options: [{ label: 'Revoke now' }, { label: 'Revoke in a week' }],
    },
    lastMessage: 'The new key is in place. Should I revoke the old one right away?', lastTurn: 't-gone-3',
  })]),

  zero: (now) => base(now, queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived))),
  empty: (now) => base(now, []),
  norepos: () => ({ roots: [], repos: [], sessions: [], flags: {} }),

  volume: (now) => crowd(now, { decide: 14, prompt: 3, idle: 7, working: 16, exited: 3 }),
  // The most items the meter still draws one segment each for.
  volume20: (now) => crowd(now, { decide: 12, prompt: 3, idle: 5, working: 16, exited: 3 }),
  volume45: (now) => crowd(now, { decide: 30, prompt: 5, idle: 10, working: 16, exited: 0 }),
};
