export const wsUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`;

// A refusal keeps the server's code ('stale', 'answered', …), so callers can tell refusals apart.
export interface ApiError extends Error {
  code?: string;
  status: number;
}

export async function api<T = void>(method: string, path: string, body?: unknown, { keepalive = false } = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    const failure: ApiError = Object.assign(new Error(err.error ?? res.statusText), { code: err.code as string | undefined, status: res.status });
    throw failure;
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export async function upload(file: File) {
  const res = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted') },
    body: file,
  });
  const out = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out.path as string;
}

export const sessionAction = (id: string, action: string, body?: unknown, options?: { keepalive?: boolean }) =>
  api('POST', `/api/sessions/${id}/${action}`, body ?? {}, options);
