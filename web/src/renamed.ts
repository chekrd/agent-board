// Drafts, sends and settings kept before the rename to Pitwall move to its keys, before any module reads them.
for (const storage of [localStorage, sessionStorage]) {
  try {
    for (const key of Object.keys(storage).filter((k) => k.startsWith('agent-board:'))) {
      const renamed = `pitwall:${key.slice('agent-board:'.length)}`;
      if (storage.getItem(renamed) === null) storage.setItem(renamed, storage.getItem(key)!);
      storage.removeItem(key);
    }
  } catch {
    // storage unavailable
  }
}
