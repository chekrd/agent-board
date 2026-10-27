import type { Session } from '../../server/db.ts';
import type { Usage } from '../../server/usage.ts';
import { menuAnswerText } from '../../server/decision.ts';
import type { RepoView } from '../../server/workspace.ts';
import { addFromTemplate, queue, repos, ROOTS, session, titleOf, type Template } from './fixtures.ts';

export type Flag = 'explainFails' | 'lossFails';

export interface Scenario {
  roots: string[];
  repos: RepoView[];
  sessions: Session[];
  usage: Usage | null;
  flags: Record<string, Flag[]>;
}

const MIN = 60_000;

const base = (now: number, sessions: Session[]): Scenario => ({
  roots: ROOTS, repos: repos(now), sessions, flags: { 's-group': ['explainFails'], 's-stripe': ['lossFails'] },
  usage: { fiveHour: { percent: 34, resetsAt: now + 133 * MIN }, sevenDay: { percent: 61, resetsAt: now + 3 * 24 * 60 * MIN }, at: now - MIN },
});

const withSession = (sessions: Session[], id: string, patch: Partial<Session>) => sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));

const kindOf = (s: Session) =>
  s.archived ? 'archived' : s.menu || s.question || s.summary?.decision ? 'decide' : s.status === 'waiting' ? 'prompt' : s.status;

const DECIDING = ['ask', 'turn', 'menu'] as const;

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

  long: (now) => base(now, queue(now).map((s) => (s.id === 's-hooks' && s.menu ? {
    ...s,
    menu: {
      ...s.menu,
      questions: [
        ...s.menu.questions,
        {
          header: 'Dead endpoints', question: 'When should an endpoint count as dead and stop getting deliveries at all?', multiSelect: false,
          options: [
            { label: 'After 3 deliveries give up', description: 'Counted per endpoint over a rolling 24 h; the owner re-enables it from the dashboard' },
            { label: 'After 24 h of failures', description: 'Any delivery that succeeds in between resets the clock' },
            { label: 'Never', description: 'Keep trying every new event; only the retries of each delivery stop' },
          ],
        },
      ],
    },
  } : s.id !== 's-cart' || !s.question ? s : {
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

  'menu-stuck': (now) => base(now, queue(now).map((s) => (s.id !== 's-hooks' || !s.menu ? s : {
    ...s, answered: { key: `m:${s.menu.toolUseId}`, text: menuAnswerText(s.menu, s.advice!.answers!), at: now - MIN },
  }))),

  'turn-long': (now) => base(now, [...queue(now), session({
    id: 's-push', repoId: 1, worktree: '~/code/worktrees/asset-uploads/storefront', tty: '/dev/ttys017', pid: 81311,
    title: 'Keep the upload warning across folders', firstPrompt: 'Leaving the page mid-upload sometimes gives no warning. Find out why.',
    status: 'idle', createdAt: now - 90 * MIN, updatedAt: now - MIN, rank: 5, rankReason: 'Only a push waits on it',
    summary: {
      text: 'The branch is 6 commits on master; Claude asks whether to force-push it.', progress: ['Fixed the navigation guard'], learnings: [],
      decision: {
        problem: 'Should Claude force-push the rebased branch?',
        brief: 'The branch was rebased onto master, so the push needs --force-with-lease. Typecheck and lint are clean. Claude waits for your go-ahead before publishing anything.',
        context: '- Top commit: `7bb08719db4`\n- Not pushed yet',
        options: [{ label: 'Push', description: 'Force-push with --force-with-lease' }, { label: "Don't push yet", description: 'Keep the branch local' }],
      },
      question: null, basis: 't-push-6', at: now - MIN,
    },
    lastMessage: [
      '**#2:** I dropped that commit locally, so the selection still passes whole asset objects.',
      '**#3:** What changed is which uploads count as still running when the warning decides whether to show.',
      '- **Before:** it only counted running uploads that were also in `listingUploads`.',
      '- **Why that missed some:** `listingUploads` is cleared when you open a folder or change the search.',
      '- **Now:** it counts every entry in `uploads` that has `_uploading` set.',
      'Searching or opening a folder still clears the upload tiles, so this commit only keeps the warning working.',
      'The local branch is now 6 review commits on the latest master. It still needs `--force-with-lease`. Should I push it?',
    ].join('\n\n'),
    lastTurn: 't-push-6',
  })]),

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

  // A finished review whose findings are answered one by one: the second is rejected, the first has a subtask at work.
  findings: (now) => {
    const basis = 't-review-4';
    const worktree = '~/code/worktrees/lazy-reviews/storefront';
    return base(now, [...queue(now).filter((s) => s.id !== 's-reviews'), session({
      id: 's-review', repoId: 1, worktree, tty: '/dev/ttys030', pid: 80500,
      title: 'Review the lazy reviews branch', firstPrompt: 'Review this branch against main.',
      status: 'idle', createdAt: now - 40 * MIN, updatedAt: now - 5 * MIN,
      summary: {
        text: 'The review of the branch found three issues, none verified yet.', progress: ['Reviewed main...HEAD, 5 files'], learnings: [],
        decision: null, findings: 3, question: null, basis, at: now - 5 * MIN,
      },
      findings: {
        basis,
        items: [
          {
            title: 'Reviews load twice on a fast scroll', location: 'src/reviews/LazyReviews.tsx:41',
            detail: 'The `IntersectionObserver` callback calls `load()` without checking whether a load is already running, so a fast scroll past the section starts two requests.',
          },
          {
            title: 'The skeleton has no accessible name', location: 'src/reviews/Skeleton.tsx:8',
            detail: 'Screen readers announce an empty region while reviews load.', rejected: { reason: 'Covered by the a11y ticket', at: now - 4 * MIN },
          },
          {
            title: 'The 600 px margin is hard-coded', location: '',
            detail: 'The margin should come from `config/lazy.ts` like the other lazy sections.',
          },
        ],
      },
      lastMessage: 'The review found 3 issues:\n\n1. **Reviews load twice on a fast scroll** (`src/reviews/LazyReviews.tsx:41`)\n2. **The skeleton has no accessible name** (`src/reviews/Skeleton.tsx:8`)\n3. **The 600 px margin is hard-coded**',
      lastTurn: basis, diffstat: { files: 5, insertions: 96, deletions: 12 },
    }), session({
      id: 's-review-1', repoId: 1, worktree, tty: '/dev/ttys031', pid: 80510,
      title: '#1 Fix · Reviews load twice on a fast scroll', firstPrompt: 'Fix finding 1.',
      status: 'working', createdAt: now - 3 * MIN, updatedAt: now - MIN,
      activity: { step: 'Read src/reviews/LazyReviews.tsx', since: now - 3 * MIN },
      parent: { id: 's-review', basis, finding: 0, title: 'Reviews load twice on a fast scroll', kind: 'accept', text: 'Guard it with a ref' },
      findings: {
        basis: 't-fix-2',
        items: [{ title: 'The guard is not reset on unmount', location: 'src/reviews/LazyReviews.tsx:52', detail: 'A remount while a load runs keeps `loading.current` true, so the section never loads again.' }],
      },
    }), session({
      id: 's-review-1-1', repoId: 1, worktree, tty: '/dev/ttys033', pid: 80530,
      title: '#1 Explain · The guard is not reset on unmount', firstPrompt: 'Explain finding 1.',
      status: 'idle', createdAt: now - 90_000, updatedAt: now - 30_000, lastTurn: 't-explain-1',
      summary: {
        text: 'A remount happens when the product tabs switch; the stale guard then blocks every later load.', progress: [], learnings: [],
        decision: null, findings: 0, question: null, basis: 't-explain-1', at: now - 30_000,
      },
      parent: { id: 's-review-1', basis: 't-fix-2', finding: 0, title: 'The guard is not reset on unmount', kind: 'elaborate', text: '' },
    }), session({
      id: 's-review-2', repoId: 1, worktree, tty: '/dev/ttys032', pid: 80520,
      title: '#1 Second look · Reviews load twice on a fast scroll', firstPrompt: 'Take a second look at finding 1.',
      status: 'idle', createdAt: now - 2 * MIN, updatedAt: now - MIN, rank: 5, rankReason: 'Decides whether #1 is worth fixing',
      question: {
        toolUseId: 'toolu_01Look', category: 'plan-problem', askedAt: now - MIN, title: 'Is the double load worth guarding?',
        details: 'The second request is cancelled by the router before it lands, so users never see it.',
        options: [{ label: 'Guard it', description: 'One less request on a fast scroll' }, { label: 'Leave it', description: 'The router already drops it' }],
      },
      lastTurn: 't-look-1',
      parent: { id: 's-review', basis, finding: 0, title: 'Reviews load twice on a fast scroll', kind: 'second-look', text: '' },
    })]);
  },

  zero: (now) => base(now, queue(now).filter((s) => s.status === 'working' || (s.status === 'exited' && !s.archived))),
  empty: (now) => base(now, []),
  norepos: () => ({ roots: [], repos: [], sessions: [], usage: null, flags: {} }),

  volume: (now) => crowd(now, { decide: 14, prompt: 3, idle: 7, working: 16, exited: 3 }),
  // The most items the meter still draws one segment each for.
  volume20: (now) => crowd(now, { decide: 12, prompt: 3, idle: 5, working: 16, exited: 3 }),
  volume45: (now) => crowd(now, { decide: 30, prompt: 5, idle: 10, working: 16, exited: 0 }),
};
