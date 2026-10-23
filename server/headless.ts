import { spawn } from 'node:child_process';
import { loginEnv, which } from './env.ts';

const CLAUDE = await which('claude');

export interface HeadlessOptions {
  cwd: string;
  args: string[];
  timeoutMs: number;
  signal?: AbortSignal;
  onEvent?: (event: Record<string, any>) => void;
}

// With onEvent the run streams its messages and the final result is the stream's `result` event.
export function headless(prompt: string, opts: HeadlessOptions): Promise<Record<string, any>> {
  const format = opts.onEvent ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json'];
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, ['-p', ...format, '--no-session-persistence', ...opts.args], {
      cwd: opts.cwd,
      env: loginEnv,
      signal: opts.signal,
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    let out = '';
    let err = '';
    let result: Record<string, any> | null = null;
    let partial = '';
    child.stdout.on('data', (d) => {
      if (!opts.onEvent) return void (out += d);
      const lines = (partial + d).split('\n');
      partial = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.type === 'result') result = event;
          else opts.onEvent(event);
        } catch {
          // not an event line
        }
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => reject(e.name === 'AbortError' ? new Error('stopped') : e));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (opts.signal?.aborted) return reject(new Error('stopped'));
      if (code !== 0) return reject(new Error(signal ? 'claude -p timed out' : `claude -p exited ${code}: ${err || out}`.slice(0, 1000)));
      if (opts.onEvent) return result ? resolve(result) : reject(new Error('claude -p ended without a result'));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude -p printed invalid JSON: ${out.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
