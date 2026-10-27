import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { LIVE_PORT, refuseLive } from '../isolate.ts';
import { launch, lookName, sleep, type Browser, type Look } from './cdp.ts';
import { checks, type Check } from './checks.ts';
import { startMock, type Mock } from './mock.ts';

// pnpm e2e [--only <pattern>] [--matrix] [--workers <n>] [--port <mock port>] [--shots <dir>] [--dist <dir>]
// Runs the checks in checks.ts against the mock in a headless Brave of its own. While changing something, run the
// checks it touches with --only and the whole suite once before committing. Each worker has a mock on a free port
// and a browser of its own (--workers, default half the cores, at most 6); with --port, one worker uses that mock.
// Each check runs once, in dark: a check switches the system to light and back for its colour assertions (themes())
// and its screenshots, so both schemes are covered; --matrix instead runs every check in each scheme, at 1100×900
// and with reduced motion too. --shots saves each check's screenshots under <dir>/<look>/; failures always land in
// .e2e/. A check fails on an error in the page and on a request to any host but 127.0.0.1, where the mocks are.

const ROOT = resolve(import.meta.dirname, '../..');
const FAILURES = join(ROOT, '.e2e');
const CHECK_TIMEOUT_MS = 60_000;
const FAST_CLOCK = 4;

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    matrix: { type: 'boolean', default: false },
    port: { type: 'string' },
    shots: { type: 'string' },
    workers: { type: 'string' },
    dist: { type: 'string', default: join(ROOT, 'web', 'dist') },
  },
});
if (args.port) refuseLive(Number(args.port));
if (!existsSync(join(resolve(args.dist), 'index.html'))) {
  console.error(`no UI build in ${args.dist}; run pnpm build first`);
  process.exit(2);
}
process.env.AGENT_BOARD_E2E_DIST = resolve(args.dist);
// The mock's times are set from now, such as a limit that resets in 133 min, and a time on another day shows its
// weekday too, which widens the top bar. A zone where the run starts at 10:00 keeps them all on one day; the mock
// and the browser take it from this process.
const offset = ((10 - new Date().getUTCHours() + 36) % 24) - 12;
process.env.TZ = offset ? `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}` : 'Etc/GMT';

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
const perScheme: readonly Look['scheme'][] = args.matrix ? schemes : ['dark'];
const runs: [Check, Look][] = [...runsIn(looks(wide, perScheme), false), ...runsIn(looks(narrow, perScheme), true)];
const workers = args.port ? 1 : Math.max(1, Math.min(runs.length, Number(args.workers ?? Math.min(6, Math.floor(availableParallelism() / 2)))));
if (!runs.length) {
  console.error(`no check matches ${args.only}`);
  process.exit(2);
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

const mocks: Mock[] = [];
const browsers: Browser[] = [];
const stop = async () => {
  await Promise.all(browsers.map((b) => b.close().catch(() => {})));
  await Promise.all(mocks.map((m) => m.stop().catch(() => {})));
};
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => void stop().then(() => process.exit(130)));
}

const other = (scheme: Look['scheme']): Look['scheme'] => (scheme === 'dark' ? 'light' : 'dark');

async function runOne(mock: Mock, browser: Browser, check: Check, look: Look) {
  await mock.reset(check.scenario ?? 'queue');
  const page = await browser.newPage(look);
  const speed = check.clock === 'fast' ? FAST_CLOCK : 1;
  if (speed !== 1) await page.fastClock(speed);
  const settled = () => page.until('the transitions to end', () => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState === 'finished'));
  let current = look.scheme;
  // Inside themes() a screenshot is of the scheme being checked only.
  let inside = false;
  const themes = async (fn: (scheme: Look['scheme']) => Promise<void>) => {
    inside = true;
    try {
      await fn(look.scheme);
      if (args.matrix) return;
      current = other(look.scheme);
      await page.scheme(current);
      try {
        await settled();
        await fn(current);
      } finally {
        current = look.scheme;
        await page.scheme(current);
      }
      await settled();
    } finally {
      inside = false;
    }
  };
  const save = async (scheme: Look['scheme'], name: string) => {
    await settled();
    await page.shot(join(resolve(args.shots!, lookName({ ...look, scheme })), `${name}.png`));
  };
  const shot = async (name: string) => {
    if (!args.shots) return;
    if (inside) return save(current, name);
    await themes((scheme) => save(scheme, name));
  };
  // What the page times shrinks; the half second the check allows for delivery and rendering does not.
  const wait = async (ms: number) => {
    await sleep(speed === 1 ? ms : ms / speed + 500);
  };
  try {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      check.run({ page, mock, look, shot, themes, wait }),
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

// Results print in the order of the runs, each as soon as it and every run before it are done.
const results: (string | undefined)[] = [];
let printed = 0;
let failed = 0;
const report = (i: number, line: string) => {
  results[i] = line;
  while (results[printed] !== undefined) console.log(results[printed++]);
};

async function work(next: () => number | undefined) {
  const mock = await startMock({ port: args.port ? Number(args.port) : undefined, dist: resolve(args.dist) });
  mocks.push(mock);
  const browser = await launch();
  browsers.push(browser);
  for (let i = next(); i !== undefined; i = next()) {
    const [check, look] = runs[i];
    const started = Date.now();
    const failure = await runOne(mock, browser, check, look);
    const took = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (!failure) {
      report(i, `ok    ${check.name} [${lookName(look)}] ${took}`);
      continue;
    }
    failed++;
    const message = failure.err instanceof Error ? (failure.err.stack ?? failure.err.message) : String(failure.err);
    report(i, `FAIL  ${check.name} [${lookName(look)}] ${took}\n      ${message.split('\n').join('\n      ')}\n      screenshot: ${relative(process.cwd(), failure.file)}`);
  }
}

const began = Date.now();
try {
  console.log(`e2e: ${runs.length} runs, ${workers} ${workers === 1 ? 'worker' : 'workers'}${args.port ? ` against the mock on port ${args.port}` : ''}`);
  let taken = 0;
  const next = () => (taken < runs.length ? taken++ : undefined);
  await Promise.all(Array.from({ length: workers }, () => work(next)));
  console.log(`${runs.length - failed} passed, ${failed} failed in ${Math.round((Date.now() - began) / 1000)} s`);
} finally {
  await stop();
}
process.exitCode = failed ? 1 : 0;
