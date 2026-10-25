import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { refuseLive } from '../isolate.ts';
import { sleep, until } from './cdp.ts';

const SERVER = join(import.meta.dirname, '..', 'mock', 'server.ts');

export interface Entry {
  at: number;
  method: string;
  path: string;
  query: string;
  action: string | null;
  sessionId: string | null;
  body: any;
  raw?: string;
  status: number | null;
  code: string | null;
}

export type Mock = ReturnType<typeof client>;

function client(url: string, stop: () => Promise<void>) {
  refuseLive(url);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
  };
  return {
    url,
    stop,
    post: (path: string, body: unknown = {}) => call('POST', path, body),
    get: (path: string) => call('GET', path),
    log: (): Promise<Entry[]> => call('GET', '/mock/log'),
    async reset(scenario: string) {
      await call('POST', `/mock/scenario/${scenario}`);
      await call('GET', '/mock/log?clear=1');
    },
  };
}

export async function startMock(o: { port?: number; dist: string }) {
  if (o.port) return client(`http://127.0.0.1:${o.port}`, async () => {});
  const child = spawn(process.execPath, [SERVER, '--port', '0', '--dist', o.dist], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  let exited = false;
  child.once('exit', () => (exited = true));
  const url = await until('the mock to listen', () => {
    if (exited) throw new Error(`the mock exited: ${output}`);
    return output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  }, 15_000);
  return client(url, async () => {
    if (exited) return;
    child.kill('SIGTERM');
    for (let i = 0; i < 40 && !exited; i++) await sleep(50);
    if (!exited) child.kill('SIGKILL');
  });
}
