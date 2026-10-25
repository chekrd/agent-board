import { createHash } from 'node:crypto';
import type { Command } from '../../server/commands.ts';
import type { Conversation } from '../../server/conversations.ts';
import type { Session } from '../../server/db.ts';
import type { RepoView, WorktreeView } from '../../server/workspace.ts';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const ROOTS = ['~/code', '~/git/github'];

const head = (path: string) => createHash('sha1').update(path).digest('hex');

const conversation = (id: string, title: string, firstPrompt: string | null, updatedAt: number, livePid: number | null = null): Conversation =>
  ({ id, title, firstPrompt, updatedAt, livePid });

const worktree = (path: string, branch: string, conversations: Conversation[] = [], isMain = false): WorktreeView =>
  ({ path, branch, head: head(path), isMain, conversations });

export const worktreeRootOf = (repoPath: string) => `${repoPath.slice(0, repoPath.lastIndexOf('/'))}/worktrees`;

function repo(id: number, path: string, opts: { baseBranch?: string; setupCommand?: string }, worktrees: WorktreeView[]): RepoView {
  return {
    id, path, name: path.split('/').at(-1)!, baseBranch: opts.baseBranch ?? null, setupCommand: opts.setupCommand ?? null, worktreeRoot: null,
    base: opts.baseBranch ?? 'origin/main', defaultWorktreeRoot: worktreeRootOf(path), worktrees,
  };
}

export function repos(now: number): RepoView[] {
  return [
    repo(1, '~/code/storefront', { setupCommand: 'pnpm install' }, [
      worktree('~/code/storefront', 'main', [
        conversation('c-sf-1', 'Spike: edge caching for PLP', 'Spike: can the product listing page be cached at the edge per region?', now - 5 * DAY),
        conversation('c-sf-2', 'Bump Next.js to 16.2', 'Bump Next.js to 16.2 and fix the deprecations.', now - 9 * DAY),
      ], true),
      worktree('~/code/worktrees/guest-cart-merge/storefront', 'guest-cart-merge', [conversation('s-cart', 'Merge guest cart on login', null, now - 3 * MIN, 81234)]),
      worktree('~/code/worktrees/lazy-reviews/storefront', 'lazy-reviews', [conversation('s-reviews', 'Lazy-load product reviews', null, now - 17 * MIN, 80411)]),
      worktree('~/code/worktrees/search-typos/storefront', 'search-typos', [conversation('s-search', 'Typo-tolerant search', null, now - MIN, 79902)]),
    ]),
    repo(2, '~/code/billing-api', { baseBranch: 'develop', setupCommand: 'pnpm install && pnpm db:migrate' }, [
      worktree('~/code/billing-api', 'develop', [], true),
      worktree('~/code/worktrees/webhook-retries/billing-api', 'webhook-retries', [conversation('s-hooks', 'Retry failed webhooks', null, now - 9 * MIN, 78120)]),
      worktree('~/code/worktrees/invoice-rounding/billing-api', 'invoice-rounding', [conversation('s-invoice', 'Fix invoice PDF rounding', null, now - MIN, 77031)]),
      worktree('~/code/worktrees/stripe-18/billing-api', 'stripe-18', [conversation('s-stripe', 'Upgrade Stripe SDK to v18', null, now - 3 * HOUR)]),
    ]),
    repo(3, '~/git/github/agent-board', {}, [
      worktree('~/git/github/agent-board', 'main', [conversation('s-split', 'Split-only diff view', null, now - 2 * DAY)], true),
      worktree('~/git/github/worktrees/board-grouping/agent-board', 'board-grouping', [conversation('s-group', 'Group board tiles by repo', null, now - 6 * MIN, 76555)]),
      worktree('~/git/github/worktrees/artifact-thumbs/agent-board', 'artifact-thumbs', [conversation('s-thumbs', 'Artifact thumbnails in Overview', null, now - MIN, 76002)]),
    ]),
    repo(4, '~/code/docs-site', { setupCommand: 'pnpm install' }, [
      worktree('~/code/docs-site', 'main', [], true),
      worktree('~/code/worktrees/astro-5/docs-site', 'astro-5', [conversation('s-astro', 'Migrate docs to Astro 5', null, now - 2 * MIN, 75310)]),
      worktree('~/code/worktrees/fix-anchors/docs-site', 'fix-anchors', [conversation('s-anchors', 'Fix broken doc anchors', null, now - 21 * MIN, 74888)]),
    ]),
  ];
}

type Given = Pick<Session, 'id' | 'repoId' | 'worktree' | 'title' | 'firstPrompt' | 'status' | 'createdAt' | 'updatedAt'>;

export const session = (fields: Given & Partial<Session>): Session => ({
  cwd: fields.worktree, pid: null, tty: null, question: null, rank: null, rankReason: null, diffstat: null, lastMessage: null, lastTurn: null,
  waitingFor: null, dismissedAsk: null, advice: null, pr: null, summary: null, explanation: null, activity: null, menu: null, answered: null,
  artifacts: [], archived: false, ...fields,
});

export function queue(now: number): Session[] {
  return [
    session({
      id: 's-cart', repoId: 1, worktree: '~/code/worktrees/guest-cart-merge/storefront', tty: '/dev/ttys014', pid: 81234,
      title: 'Merge guest cart on login',
      firstPrompt: 'Shoppers lose their guest cart when they log in (CHK-412). Fix it, keep the change small and add tests.',
      status: 'idle', createdAt: now - 52 * MIN, updatedAt: now - 3 * MIN,
      rank: 1, rankReason: 'Blocks the checkout fix; Claude idles until you answer',
      question: {
        toolUseId: 'toolu_01Cart', category: 'product decision', askedAt: now - 4 * MIN,
        title: 'Guest cart or account cart when a shopper logs in?',
        details: 'When a guest logs in, `CartService.mergeOnLogin` is a no-op, so the guest cart is dropped and the account cart wins.\n\nThe two carts can disagree:\n\n- **Guest cart:** 2 × Trail Runner 42 (1 in stock), 1 × Wool Socks\n- **Account cart:** 1 × Trail Runner 42\n\nWhatever we pick also applies to the mobile app, which calls the same endpoint.',
        options: [
          { label: 'Merge both carts', description: 'Add up quantities per product, capped at stock; a toast lists anything trimmed', recommended: true },
          { label: 'Keep the account cart', description: 'Drop the guest cart as today, but tell the shopper' },
          { label: 'Ask the shopper', description: 'A choice dialog after login; one more step before checkout' },
        ],
      },
      summary: {
        text: 'Cart merge drafted with stock caps; waiting for your merge rule before wiring it into login.',
        progress: ['Found CartService.mergeOnLogin is a no-op', 'Wrote failing tests for three merge cases', 'Drafted mergeCarts() with stock caps'],
        learnings: ['Guest carts live in a cookie that expires after 24 h, so most of them never reach a login.'],
        decision: { problem: 'What should happen to a guest cart when the shopper logs in?', brief: 'Both carts can hold items; today the guest cart is silently dropped.', context: '', options: [] },
        question: 'toolu_01Cart', basis: 't-cart-6', at: now - 3 * MIN,
      },
      advice: {
        key: 'q:toolu_01Cart', state: 'done', startedAt: now - 3 * MIN, at: now - 2 * MIN, activity: null,
        choice: 'Merge both carts', confidence: 82,
        answer: 'Merge both carts. Cap each line at available stock and show a toast listing anything trimmed.',
        reasoning: 'CHK-412 says a cart must never lose items, and merging is the only option that satisfies it. Stock caps already exist in CartService.reserve().',
      },
      explanation: {
        key: 'q:toolu_01Cart', state: 'done', at: now - MIN,
        text: '**Background.** `src/auth/onLogin.ts` calls `CartService.mergeOnLogin(guestId, userId)`, which returns early (`src/cart/CartService.ts:88`). The guest cart cookie `sf_guest_cart` expires after 24 h.\n\n**Merge both carts** adds `mergeCarts()` (already drafted) and calls it from `onLogin`. Quantities above stock are trimmed by `reserve()`; the toast needs one new string in `messages/cart.json`.\n\n**Keep the account cart** needs no code beyond a notice, but CHK-412\'s acceptance criterion "no items are lost" stays unmet.\n\n**Ask the shopper** needs a new dialog (`web/checkout/LoginCartDialog.tsx`) and an API flag; the mobile app would need the same dialog.',
      },
      lastMessage: 'I drafted `mergeCarts()` in `src/cart/mergeCarts.ts` and three failing tests that pin down the cases:\n\n1. Disjoint carts → union of both\n2. Same product in both → quantities add up, capped at stock\n3. Empty guest cart → account cart unchanged\n\nBefore wiring it into `onLogin` I need your call on the merge rule, so I asked through Agent Board.',
      lastTurn: 't-cart-6', diffstat: { files: 4, insertions: 211, deletions: 8 },
      artifacts: [
        { id: 'art-cart-1', title: 'Cart merge — before and after', at: now - 6 * MIN },
        { id: 'art-cart-2', title: 'Login flow with the merge step', at: now - 5 * MIN },
      ],
    }),
    session({
      id: 's-hooks', repoId: 2, worktree: '~/code/worktrees/webhook-retries/billing-api', tty: '/dev/ttys009', pid: 78120,
      title: 'Retry failed webhooks',
      firstPrompt: 'Webhook deliveries that fail are never retried (BILL-88). Add retries with backoff and stop hammering dead endpoints.',
      status: 'waiting', createdAt: now - 2 * HOUR, updatedAt: now - 9 * MIN,
      rank: 2, rankReason: 'Two quick questions; the worker code waits on them',
      menu: {
        toolUseId: 'toolu_01Hooks', at: now - 9 * MIN,
        questions: [
          {
            header: 'Backoff', question: 'Which retry schedule should failed webhook deliveries use?', multiSelect: false,
            options: [
              { label: 'Exponential, 5 tries', description: '1 min, 5 min, 25 min, 2 h, 10 h' },
              { label: 'Every 15 min, 8 tries', description: 'Even load on receivers; gives up after 2 h' },
              { label: 'Linear, 6 tries', description: '10, 20, 30, 40, 50, 60 min' },
            ],
          },
          {
            header: 'Give up', question: 'What should happen when a delivery gives up?', multiSelect: true,
            options: [
              { label: 'Email the account owner', description: 'Uses the existing billing-notice template' },
              { label: 'Post to #billing-alerts', description: 'The Slack webhook is configured in staging and prod' },
              { label: 'Disable the endpoint', description: 'No further attempts until the owner re-enables it' },
            ],
          },
        ],
      },
      summary: {
        text: 'Retry queue and schema are in place; Claude asks which schedule and give-up behavior to use.',
        progress: ['Added the webhook_attempts table and migration', 'Moved delivery into a BullMQ worker', 'Left the retry policy configurable'],
        learnings: [], decision: null, question: null, basis: 't-hooks-3', at: now - 8 * MIN,
      },
      advice: {
        key: 'm:toolu_01Hooks', state: 'done', startedAt: now - 8 * MIN, at: now - 7 * MIN, activity: null, choice: null, answer: '', confidence: 64,
        answers: [{ labels: ['Exponential, 5 tries'], other: '' }, { labels: ['Email the account owner', 'Disable the endpoint'], other: '' }],
        reasoning: 'BILL-88 asks to stop hammering dead endpoints, which argues for exponential backoff and disabling them. Nobody asked for Slack alerts.',
      },
      lastMessage: 'The worker, the `webhook_attempts` table and the migration are done. I opened a question in the terminal about the retry schedule and what to do when a delivery finally fails.',
      lastTurn: 't-hooks-3', diffstat: { files: 6, insertions: 340, deletions: 22 },
    }),
    session({
      id: 's-group', repoId: 3, worktree: '~/git/github/worktrees/board-grouping/agent-board', tty: '/dev/ttys021', pid: 76555,
      title: 'Group board tiles by repo',
      firstPrompt: 'Try grouping the board tiles by repository. Keep attention order inside groups.',
      status: 'idle', createdAt: now - 70 * MIN, updatedAt: now - 6 * MIN,
      rank: 3, rankReason: 'Quick call; nothing else waits on it',
      summary: {
        text: 'Both groupings work behind a flag; Claude wants one default before writing tests.',
        progress: ['Added GROUP_BY to web/src/order.ts', 'Repo sections reuse the tile component'],
        learnings: [],
        decision: {
          problem: 'Which grouping should the board keep?',
          brief: 'The prototype supports both; Claude needs one default before writing tests.',
          context: 'Claude built both groupings behind `GROUP_BY` in `web/src/order.ts`:\n\n- **By attention** (today): Decide, Needs focus, Your turn, In progress, Ended\n- **By repo**: one section per repository, attention order inside each\n\nWith 12 tiles over 4 repos, grouping by repo spreads the 3 Decide tiles over 3 sections.',
          options: [
            { label: 'By attention', description: 'Keep today\'s order and drop the flag' },
            { label: 'By repo', description: 'A section per repo; decisions are spread out' },
            { label: 'Attention, then repo', description: 'Attention sections, tiles sorted by repo inside each' },
          ],
        },
        question: null, basis: 't-group-4', at: now - 6 * MIN,
      },
      advice: {
        key: 's:t-group-4', state: 'thinking', startedAt: now - 41 * SEC, at: now - 41 * SEC, activity: 'Read web/src/order.ts',
        choice: null, answer: '', confidence: 0, reasoning: '',
      },
      lastMessage: 'Both groupings work behind `GROUP_BY` in `web/src/order.ts`.\n\n- **By attention** keeps decisions together at the top.\n- **By repo** makes the board read like the Repos dialog.\n\nWhich should be the default? I can also do attention sections with tiles sorted by repo inside each.',
      lastTurn: 't-group-4', diffstat: { files: 3, insertions: 120, deletions: 15 },
    }),
    session({
      id: 's-astro', repoId: 4, worktree: '~/code/worktrees/astro-5/docs-site', tty: '/dev/ttys017', pid: 75310,
      title: 'Migrate docs to Astro 5',
      firstPrompt: 'Upgrade the docs site to Astro 5 and the new content layer.',
      status: 'waiting', waitingFor: 'a permission prompt for Bash(pnpm dlx @astrojs/upgrade)', createdAt: now - 95 * MIN, updatedAt: now - 2 * MIN,
      summary: {
        text: 'Content collections moved to the new loader API; the upgrade script needs your permission to run.',
        progress: ['Moved 3 collections to glob() loaders', 'Fixed 12 frontmatter schema errors'],
        learnings: [], decision: null, question: null, basis: 't-astro-5', at: now - 2 * MIN,
      },
      lastMessage: 'Collections are on the new loaders. Next I run the official upgrade script for the remaining packages.',
      lastTurn: 't-astro-5', diffstat: { files: 14, insertions: 260, deletions: 230 },
    }),
    session({
      id: 's-reviews', repoId: 1, worktree: '~/code/worktrees/lazy-reviews/storefront', tty: '/dev/ttys011', pid: 80411,
      title: 'Lazy-load product reviews',
      firstPrompt: 'The product page loads all reviews up front. Load them when they scroll into view.',
      status: 'idle', createdAt: now - 3 * HOUR, updatedAt: now - 17 * MIN,
      summary: {
        text: 'Reviews now load when scrolled into view; product page LCP dropped by 380 ms in a local Lighthouse run.',
        progress: ['Reviews split into a lazy chunk (41 kB)', 'IntersectionObserver with a 600 px margin', 'A skeleton keeps the layout from shifting'],
        learnings: [], decision: null, question: null, basis: 't-reviews-7', at: now - 17 * MIN,
      },
      lastMessage: 'Done. The reviews section now loads when it comes within 600 px of the viewport.\n\n| | Before | After |\n|---|---|---|\n| LCP | 2.9 s | 2.5 s |\n| JS on load | 312 kB | 271 kB |\n\nTests pass (`pnpm test reviews`). Nothing is committed yet.',
      lastTurn: 't-reviews-7', diffstat: { files: 5, insertions: 96, deletions: 12 },
    }),
    session({
      id: 's-anchors', repoId: 4, worktree: '~/code/worktrees/fix-anchors/docs-site', tty: '/dev/ttys019', pid: 74888,
      title: 'Fix broken doc anchors',
      firstPrompt: 'Fix the anchors broken by the heading slug change and open a PR with pr-to-green.',
      status: 'idle', createdAt: now - 2 * HOUR, updatedAt: now - 21 * MIN,
      summary: {
        text: 'PR 77 is open, but link-check fails on three anchors in the auth guide.',
        progress: ['Fixed 41 anchors renamed by the slug change', 'Opened PR 77'],
        learnings: [], decision: null, question: null, basis: 't-anchors-4', at: now - 21 * MIN,
      },
      pr: { id: 77, url: 'https://github.com/acme/docs-site/pull/77', result: 'FAILED 1 of 9 checks: link-check (3 broken links in /guides/auth)', watching: false, at: now - 21 * MIN },
      lastMessage: 'PR 77 is up. `link-check` still fails on three anchors in `/guides/auth`; they point at headings that #71 removed. The other 41 anchors are fixed.',
      lastTurn: 't-anchors-4', diffstat: { files: 9, insertions: 41, deletions: 41 },
    }),
    session({
      id: 's-invoice', repoId: 2, worktree: '~/code/worktrees/invoice-rounding/billing-api', tty: '/dev/ttys006', pid: 77031,
      title: 'Fix invoice PDF rounding',
      firstPrompt: 'Invoice PDFs are sometimes off by a cent (BILL-91). Find out why, fix it, and get the PR green.',
      status: 'working', createdAt: now - 80 * MIN, updatedAt: now - MIN,
      activity: { step: 'Bash: pnpm test invoices --run', since: now - (3 * MIN + 12 * SEC) },
      summary: {
        text: 'Totals now use integer cents end to end; re-running the invoice tests before pushing the fix.',
        progress: ['Found float math in LineItem.total()', 'Switched to integer cents with banker\'s rounding', 'Opened PR 1842; checks running'],
        learnings: ['Two customers were billed one cent too much on three September invoices; support may want to know.'],
        decision: null, question: null, basis: 't-invoice-9', at: now - 4 * MIN,
      },
      pr: { id: 1842, url: 'https://github.com/acme/billing-api/pull/1842', result: 'RUNNING 9 checks', watching: true, at: now - 6 * MIN },
      lastMessage: 'The cent goes missing in `LineItem.total()`, which multiplies floats before rounding. I switched every amount to integer cents and pushed PR 1842; checks are running.',
      lastTurn: 't-invoice-9', diffstat: { files: 7, insertions: 88, deletions: 31 },
      artifacts: [{ id: 'art-invoice-1', title: 'Where the cent goes missing', at: now - 25 * MIN }],
    }),
    session({
      id: 's-thumbs', repoId: 3, worktree: '~/git/github/worktrees/artifact-thumbs/agent-board', tty: '/dev/ttys022', pid: 76002,
      title: 'Artifact thumbnails in Overview',
      firstPrompt: 'Show a small preview of each artifact next to its link in Overview.',
      status: 'working', createdAt: now - 14 * MIN, updatedAt: now - MIN,
      activity: { step: 'Edit web/src/components/Artifacts.tsx', since: now - 48 * SEC },
      summary: {
        text: 'Rendering a small preview of each artifact next to its link in Overview.', progress: ['Previews render in a sandboxed frame at 25% scale'],
        learnings: [], decision: null, question: null, basis: 't-thumbs-2', at: now - 2 * MIN,
      },
      lastTurn: 't-thumbs-2', diffstat: { files: 2, insertions: 64, deletions: 3 },
    }),
    session({
      id: 's-search', repoId: 1, worktree: '~/code/worktrees/search-typos/storefront', tty: '/dev/ttys012', pid: 79902,
      title: 'Typo-tolerant search',
      firstPrompt: 'Make product search tolerate one typo per word ("snaekers" should find sneakers).',
      status: 'working', createdAt: now - 46 * MIN, updatedAt: now - MIN,
      activity: { step: 'Bash: pnpm search:reindex', since: now - (12 * MIN + 30 * SEC) },
      summary: {
        text: 'Fuzzy matching is in the query builder; rebuilding the local search index to test it.',
        progress: ['Edit distance 1 for words of 4+ letters', 'Exact matches still rank first'],
        learnings: ['A full local reindex takes about 9 minutes, so each test cycle is slow.'],
        decision: null, question: null, basis: 't-search-3', at: now - 12 * MIN,
      },
      lastMessage: 'Fuzzy matching is wired into `buildQuery()`. Reindexing locally to check ranking on real data.',
      lastTurn: 't-search-3', diffstat: { files: 3, insertions: 52, deletions: 6 },
    }),
    session({
      id: 's-stripe', repoId: 2, worktree: '~/code/worktrees/stripe-18/billing-api',
      title: 'Upgrade Stripe SDK to v18',
      firstPrompt: 'Upgrade the Stripe SDK to v18 and fix whatever breaks. Use pr-to-green.',
      status: 'exited', createdAt: now - 6 * HOUR, updatedAt: now - 3 * HOUR,
      summary: {
        text: 'Upgraded to stripe@18 and fixed four type errors; PR 1839 merged.', progress: ['Fixed 4 type errors in webhooks/', 'PR 1839 merged'],
        learnings: [], decision: null, question: null, basis: 't-stripe-8', at: now - 3 * HOUR,
      },
      pr: { id: 1839, url: 'https://github.com/acme/billing-api/pull/1839', result: 'CLOSED completed', watching: false, at: now - 3 * HOUR },
      lastMessage: 'PR 1839 is merged. The four type errors were all in `webhooks/` and came from the renamed `Stripe.Event` union.',
      lastTurn: 't-stripe-8', diffstat: { files: 6, insertions: 40, deletions: 33 },
    }),
    session({
      id: 's-split', repoId: 3, worktree: '~/git/github/agent-board',
      title: 'Split-only diff view',
      firstPrompt: 'Make the diff split-only and let me resize the file list.',
      status: 'exited', createdAt: now - 2 * DAY - 2 * HOUR, updatedAt: now - 2 * DAY,
      summary: { text: 'The diff is split-only with a resizable file list.', progress: [], learnings: [], decision: null, question: null, basis: 't-split-5', at: now - 2 * DAY },
      lastMessage: 'Committed as `ae16ff0`.', lastTurn: 't-split-5',
    }),
    session({
      id: 's-edge', repoId: 1, worktree: '~/code/storefront',
      title: 'Spike: edge caching for PLP',
      firstPrompt: 'Spike: can the product listing page be cached at the edge per region?',
      status: 'exited', archived: true, createdAt: now - 5 * DAY - HOUR, updatedAt: now - 5 * DAY,
      summary: { text: 'Possible with per-region keys; personalised prices are the blocker.', progress: [], learnings: [], decision: null, question: null, basis: 't-edge-3', at: now - 5 * DAY },
      lastMessage: 'Written up in `docs/spikes/edge-cache.md`.', lastTurn: 't-edge-3',
    }),
  ];
}

export const COMMANDS: Command[] = [
  { name: 'review', description: 'Review the current changes' },
  { name: 'compact', description: 'Clear history but keep a summary in context' },
  { name: 'clear', description: 'Clear the conversation' },
  { name: 'pr-to-green', description: 'Open a PR and drive its checks to green' },
  { name: 'code-review', description: 'Review the diff for correctness bugs' },
  { name: 'simplify', description: 'Simplify the changed code' },
  { name: 'rename', description: 'Rename this session' },
  { name: 'model', description: 'Switch the model' },
];

export const DELETE_LOSS = { files: 3, commits: 2 };

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export const artifactPage = (title: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; font: 15px/1.5 system-ui, sans-serif; }
  body { margin: 24px; }
  rect { fill: light-dark(#e8eefc, #1b2540); stroke: light-dark(#5876c4, #8aa4f0); }
  text { fill: currentColor; font-size: 14px; }
  path { stroke: currentColor; fill: none; marker-end: url(#arrow); }
</style></head>
<body>
<h1>${escape(title)}</h1>
<svg viewBox="0 0 520 120" width="520" height="120" role="img" aria-label="${escape(title)}">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10z" fill="currentColor"/></marker></defs>
  <rect x="10" y="30" width="140" height="60" rx="8"/><text x="80" y="65" text-anchor="middle">Before</text>
  <path d="M155 60H215"/>
  <rect x="220" y="30" width="140" height="60" rx="8"/><text x="290" y="65" text-anchor="middle">Change</text>
  <path d="M365 60H425"/>
  <rect x="430" y="30" width="80" height="60" rx="8"/><text x="470" y="65" text-anchor="middle">After</text>
</svg>
</body></html>
`;

export const explanationOf = (title: string) =>
  `**Background.** The decision "${title}" comes from the code Claude changed in this worktree; the files involved are listed in the Diff tab.\n\n**Each choice** changes how much code moves now and how much is left for later. Claude assumed the tests cover the current behaviour; check that before deciding.`;

export const TEMPLATES = ['ask', 'turn', 'menu', 'prompt', 'idle', 'working', 'exited'] as const;
export type Template = (typeof TEMPLATES)[number];

const TEMPLATE_TITLES: Record<Template, string> = {
  ask: 'Retire the v1 orders API', turn: 'Pick one test runner', menu: 'Upgrade the build tools', prompt: 'Install the payments SDK',
  idle: 'Tidy the request logging', working: 'Speed up the CI cache', exited: 'Remove dead feature code',
};

const TITLES = [
  'Cache product prices per region', 'Retry failed exports', 'Paginate the audit log', 'Rate-limit the login endpoint',
  'Drop the legacy cart cookie', 'Speed up the search index build', 'Show stock levels on product cards',
  'Move invoices to the new PDF renderer', 'Fix the flaky checkout E2E test', 'Add dark mode to the docs',
  'Upgrade React Router to v8', 'Split the billing worker', 'Compress uploaded images', 'Track coupon usage per customer',
  'Localize order emails', 'Remove unused feature flags', 'Batch webhook deliveries', 'Add an index for order lookups',
  'Validate VAT numbers at signup', 'Archive stale carts nightly', 'Fix the timezone bug in reports', 'Add CSV export to the admin',
  'Throttle analytics events', 'Migrate sessions to Redis', 'Show delivery estimates', 'Clean up the theme tokens',
  'Fix broken sitemap entries', 'Add retries to the tax API client', 'Make the header sticky on small screens', 'Debounce the search box',
  'Warm the CDN after deploys', 'Add a health check endpoint', 'Paginate the GraphQL orders query', 'Fix a double charge on refresh',
  'Encrypt API keys at rest', 'Add a refund reason field', 'Shrink the admin bundle', 'Prefetch product pages on hover',
  'Audit role changes', 'Fix rounding in discount totals', 'Support SSO for the admin', 'Remove jQuery from the docs',
  'Cache GitHub API responses', 'Add keyboard shortcuts to the editor', 'Fix the race in inventory sync', 'Show build status in the README',
  'Generate API docs from the schema', 'Shorten the signup form', 'Fix the memory leak in the worker', 'Speed up cold starts',
];

export const titleOf = (n: number) => TITLES[n % TITLES.length] + (n >= TITLES.length ? ` (${Math.floor(n / TITLES.length) + 1})` : '');

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

function templateFields(template: Template, o: { toolUseId: string; now: number; summary: NonNullable<Session['summary']> }): Partial<Session> {
  const { toolUseId, now, summary } = o;
  switch (template) {
    case 'ask':
      return {
        question: {
          toolUseId, category: 'plan-problem', askedAt: now - 2 * MIN, title: 'Keep the old endpoint while clients migrate?',
          details: 'The new `/v2/orders` endpoint is ready, but two app versions still call `/v1/orders`.\n\n- **Keep both:** one more release of double upkeep\n- **Remove v1:** old app versions break until they update',
          options: [
            { label: 'Keep both for one release', description: 'Remove /v1 in the release after next', recommended: true },
            { label: 'Remove v1 now', description: 'Old app versions get a 410 and an update prompt' },
          ],
        },
        summary: {
          ...summary, text: 'The v2 endpoint and its tests are done; Claude asks whether v1 stays for now.', question: toolUseId,
          decision: { problem: 'Should /v1/orders stay while clients migrate?', brief: 'Keeping it costs one more release of upkeep; removing it breaks old app versions.', context: '', options: [] },
        },
        lastMessage: 'The `/v2/orders` endpoint and its tests are done. Before I delete `/v1/orders` I need to know whether old app versions must keep working, so I asked through Agent Board.',
      };
    case 'turn':
      return {
        summary: {
          ...summary, text: 'Both test runners work on the package; Claude asks which one to keep.',
          decision: {
            problem: 'Which test runner should the package keep?', brief: 'Both run the suite; Vitest is faster in watch mode, node:test needs no dependency.',
            context: '- **Vitest:** 2.1 s for the suite, watch mode\n- **node:test:** 2.8 s, no dependency',
            options: [{ label: 'Vitest', description: 'Keep vitest.config.ts and drop the node:test scripts' }, { label: 'node:test', description: 'Remove Vitest and its config' }],
          },
        },
        lastMessage: 'Both runners pass the suite. Vitest takes 2.1 s, node:test 2.8 s. Which one should I keep?',
      };
    case 'menu':
      return {
        status: 'waiting',
        menu: {
          toolUseId, at: now - 2 * MIN,
          questions: [{
            header: 'Scope', question: 'Which packages should the upgrade cover?', multiSelect: false,
            options: [{ label: 'Only the API', description: 'apps/api' }, { label: 'API and workers', description: 'apps/api and apps/worker' }, { label: 'Everything', description: 'All 9 packages' }],
          }],
        },
        lastMessage: 'The lockfile resolves. I asked in the terminal which packages the upgrade should cover.',
      };
    case 'prompt':
      return { status: 'waiting', waitingFor: 'a permission prompt for Bash(pnpm install)' };
    case 'working':
      return { status: 'working', activity: { step: 'Edit src/index.ts', since: now - 2 * MIN }, lastMessage: 'Working on it.' };
    case 'exited':
      return { status: 'exited', pid: null, tty: null, updatedAt: now - 3 * HOUR };
    case 'idle':
      return {};
  }
}

export function addFromTemplate(repo: RepoView, template: Template, o: { id: string; title?: string; now: number; rank?: number | null }): Session {
  const { id, title = TEMPLATE_TITLES[template], now } = o;
  const pathOf = (branch: string) => `${repo.defaultWorktreeRoot}/${branch}/${repo.name}`;
  const branch = repo.worktrees.some((w) => w.path === pathOf(slug(title))) ? `${slug(title)}-${id}` : slug(title);
  const path = pathOf(branch);
  const basis = `t-${id}-2`;
  const live = template !== 'exited';
  repo.worktrees.push(worktree(path, branch, [conversation(id, title, null, now - MIN, live ? 40_000 : null)]));
  const decides = template === 'ask' || template === 'turn' || template === 'menu';
  const summary = {
    text: 'The change is in place and the tests pass; nothing is committed yet.', progress: ['Changed the code', 'Added tests'], learnings: [],
    decision: null, question: null, basis, at: now - 2 * MIN,
  };
  return session({
    id, repoId: repo.id, worktree: path, title, firstPrompt: `${title}. Keep the change small and add tests.`,
    status: 'idle', createdAt: now - 30 * MIN, updatedAt: now - MIN, pid: 40_000, tty: '/dev/ttys040',
    lastTurn: basis, diffstat: { files: 3, insertions: 48, deletions: 9 }, summary,
    lastMessage: 'Done. The change is in place and the tests pass; nothing is committed yet.',
    ...(decides && { rank: o.rank ?? null, rankReason: o.rank ? 'Claude idles until you answer' : null }),
    ...templateFields(template, { toolUseId: `toolu_${id}`, now, summary }),
  });
}
