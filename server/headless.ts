import { spawn } from 'node:child_process';
import { loginEnv, which } from './env.ts';

const CLAUDE = await which('claude');

export function headless(prompt: string, opts: { cwd: string; args: string[]; timeoutMs: number }): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE, ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', ...opts.args], {
      cwd: opts.cwd,
      env: loginEnv,
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs);
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(signal ? `claude -p timed out` : `claude -p exited ${code}: ${err || out}`.slice(0, 1000)));
      try {
        resolve(JSON.parse(out));
      } catch {
        reject(new Error(`claude -p printed invalid JSON: ${out.slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}
