import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LIVE_PORT, refuseLive } from '../isolate.ts';
import { launch, lookName, sleep, type Browser, type Look } from './cdp.ts';
import { checks, type Check } from './checks.ts';
import { startMock, type Mock } from './mock.ts';

// pnpm e2e [--only <pattern>] [--matrix] [--port <mock port>] [--shots <dir>] [--dist <dir>]
// Runs the checks in checks.ts against the mock in a headless Brave of its own. Without --port it starts a mock
// on a free port. --shots saves each check's screenshots under <dir>/<look>/; failures always land in .e2e/. A check
// fails on an error in the page and on a request to any host but 127.0.0.1, where the mocks are.

const ROOT = resolve(import.meta.dirname, '../..');
const FAILURES = join(ROOT, '.e2e');
const CHECK_TIMEOUT_MS = 60_000;

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    matrix: { type: 'boolean', default: false },
    port: { type: 'string' },
    shots: { type: 'string' },
    dist: { type: 'string', default: join(ROOT, 'web', 'dist') },
  },
});
if (args.port) refuseLive(Number(args.port));
if (!existsSync(join(resolve(args.dist), 'index.html'))) {
  console.error(`no UI build in ${args.dist}; run pnpm build first`);
  process.exit(2);
}

const schemes = ['dark', 'light'] as const;
const motions = args.matrix ? (['no-preference', 'reduce'] as const) : (['no-preference'] as const);
const wide = args.matrix ? [[1440, 900], [1100, 900]] : [[1440, 900]];
const narrow = [[390, 844]];
const looks = (sizes: number[][], inSchemes: readonly Look['scheme'][] = schemes) =>
  sizes.flatMap(([width, height]) => inSchemes.flatMap((scheme) => motions.map((motion): Look => ({ scheme, width, height, motion }))));

const pattern = args.only ? new RegExp(args.only, 'i') : null;
const chosen = checks.filter((c) => !pattern || pattern.test(c.name));
// A check that asks for a motion runs with it, and once per look where the run has that motion too.
const looksOf = (c: Check, look: Look): Look[] => {
  if (!c.motion || c.motion === look.motion) return [look];
  return (motions as readonly string[]).includes(c.motion) ? [] : [{ ...look, motion: c.motion }];
};
const runsIn = (all: Look[], narrowOnes: boolean) =>
  all.flatMap((look) => chosen.filter((c) => !!c.narrow === narrowOnes).flatMap((c) => looksOf(c, look).map((l): [Check, Look] => [c, l])));
const runs: [Check, Look][] = [...runsIn(looks(wide), false), ...runsIn(looks(narrow, args.matrix ? schemes : ['dark']), true)];
if (!runs.length) {
  console.error(`no check matches ${args.only}`);
  process.exit(2);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

let mock: Mock | undefined;
let browser: Browser | undefined;
const stop = async () => {
  await browser?.close().catch(() => {});
  await mock?.stop().catch(() => {});
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stop().then(() => process.exit(130)));
}

async function runOne(mock: Mock, browser: Browser, check: Check, look: Look) {
  await mock.reset(check.scenario ?? 'queue');
  const page = await browser.newPage(look);
  const shots = args.shots ? resolve(args.shots, lookName(look)) : null;
  const shot = async (name: string) => {
    if (!shots) return;
    await page.until('the transitions to end', () => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState === 'finished'));
    await page.shot(join(shots, `${name}.png`));
  };
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      check.run({ page, mock, look, shot }),
      new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`no result after ${CHECK_TIMEOUT_MS / 1000} s`)), CHECK_TIMEOUT_MS))),
    ]).finally(() => clearTimeout(timer));
    await sleep(100);
    const unexpected = page.errors.filter((e) => !check.expectedErrors?.some((re) => re.test(e)));
    if (unexpected.length) throw new Error(`errors in the page:\n${unexpected.join('\n')}`);
    const elsewhere = page.requests.filter((url) => {
      if (/^(data|blob|about):/.test(url)) return false;
      const { hostname, port } = new URL(url);
      return hostname !== '127.0.0.1' || Number(port) === LIVE_PORT;
    });
    if (elsewhere.length) throw new Error(`requests to a host other than the mocks on 127.0.0.1:\n${elsewhere.join('\n')}`);
    return null;
  } catch (err) {
    const file = join(FAILURES, `${slug(check.name)}--${lookName(look)}.png`);
    await page.shot(file).catch(() => {});
    return { err, file };
  } finally {
    await page.close();
  }
}

let failed = 0;
try {
  mock = await startMock({ port: args.port ? Number(args.port) : undefined, dist: resolve(args.dist) });
  browser = await launch();
  console.log(`e2e: ${runs.length} runs against the mock on ${mock.url}`);
  for (const [check, look] of runs) {
    const started = Date.now();
    const failure = await runOne(mock, browser, check, look);
    const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (!failure) {
      console.log(`ok    ${check.name} [${lookName(look)}] ${took}`);
      continue;
    }
    failed++;
    const message = failure.err instanceof Error ? (failure.err.stack ?? failure.err.message) : String(failure.err);
    console.log(`FAIL  ${check.name} [${lookName(look)}] ${took}\n      ${message.split('\n').join('\n      ')}\n      screenshot: ${relative(process.cwd(), failure.file)}`);
  }
  console.log(`${runs.length - failed} passed, ${failed} failed`);
} finally {
  await stop();
}
process.exitCode = failed ? 1 : 0;
