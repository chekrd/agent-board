import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { UPLOADS_DIR } from './config.ts';

const MAX_BYTES = 30 * 1024 * 1024;
const KEEP_MS = 30 * 24 * 3600_000;

const safeName = (name: string) => name.split(/[\\/]/).at(-1)!.replace(/[^\w.-]+/g, '-').replace(/^[.-]+/, '').slice(-120) || 'file';

export async function saveUpload(name: string, bytes: ArrayBuffer) {
  if (!bytes.byteLength) throw new Error('empty file');
  if (bytes.byteLength > MAX_BYTES) throw new Error(`files over ${MAX_BYTES / 1024 / 1024} MB are not accepted`);
  void prune();
  const dir = join(UPLOADS_DIR, randomUUID());
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeName(name));
  await writeFile(path, new Uint8Array(bytes));
  return path;
}

export async function checkUploads(paths: unknown) {
  if (paths === undefined) return [];
  if (!Array.isArray(paths)) throw new Error('files must be a list');
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(UPLOADS_DIR + sep) || p.includes('..') || /\s/.test(p)) throw new Error('unknown attachment');
    if (!(await stat(p).catch(() => null))?.isFile()) throw new Error(`attachment ${p} is gone; paste it again`);
  }
  return paths as string[];
}

async function prune() {
  const dirs = await readdir(UPLOADS_DIR).catch(() => []);
  for (const d of dirs) {
    const info = await stat(join(UPLOADS_DIR, d)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > KEEP_MS) await rm(join(UPLOADS_DIR, d), { recursive: true, force: true });
  }
}
