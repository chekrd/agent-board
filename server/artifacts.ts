import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSIONS_DIR } from './config.ts';
import type { ToolCall } from './conversations.ts';
import type { Artifact, Session } from './db.ts';
import { artifactInput } from './mcp.ts';

const ID = /^[\w-]+$/;

const dir = (sessionId: string) => join(SESSIONS_DIR, sessionId, 'artifacts');

export function artifactFile(sessionId: string, id: string) {
  if (!ID.test(sessionId) || !ID.test(id)) throw new Error('bad artifact id');
  return join(dir(sessionId), `${id}.html`);
}

// Only the transcript holds an artifact's HTML, and only until the call scrolls out of the part
// that is read, so each one is saved once when first seen. A later call with the same title
// replaces it; the older call, still in the transcript, must not bring it back.
export async function storeArtifacts(s: Session, calls: ToolCall[]): Promise<Artifact[] | null> {
  let list = s.artifacts;
  for (const call of calls) {
    if (list.some((a) => a.id === call.toolUseId)) continue;
    const input = artifactInput.safeParse(call.input);
    if (!input.success) continue;
    const { title, html } = input.data;
    if (list.some((a) => a.title === title && a.at >= call.at)) continue;
    await mkdir(dir(s.id), { recursive: true });
    await writeFile(artifactFile(s.id, call.toolUseId), html);
    for (const old of list.filter((a) => a.title === title)) await rm(artifactFile(s.id, old.id), { force: true });
    list = [...list.filter((a) => a.title !== title), { id: call.toolUseId, title, at: call.at }];
  }
  return list === s.artifacts ? null : list;
}

// Artifacts are written by an agent; the page runs with an opaque origin and cannot load or send anything.
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'sandbox allow-scripts',
].join('; ');
