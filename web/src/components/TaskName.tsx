import { useRef, useState } from 'react';
import { sessionAction } from '../api.ts';
import type { Session } from '../types.ts';
import styles from './TaskName.module.css';

export function TaskName({ session, name }: { session: Session; name: string }) {
  const [editing, setEditing] = useState(false);
  const cancelled = useRef(false);
  if (!editing) {
    return (
      <h2 className={styles.title}>
        <button type="button" className={styles.name} title="Click to rename; the Claude session gets the same name" onClick={() => setEditing(true)}>
          {name}
        </button>
      </h2>
    );
  }
  const save = (value: string) => {
    setEditing(false);
    if (cancelled.current || !value.trim() || value.trim() === name) return;
    sessionAction(session.id, 'rename', { title: value }).catch(reportError);
  };
  return (
    <input
      className={styles.input}
      defaultValue={name}
      aria-label="Task name"
      title="Enter saves, Esc cancels"
      spellCheck={false}
      autoFocus
      onFocus={(e) => {
        cancelled.current = false;
        const end = e.currentTarget.value.length;
        e.currentTarget.setSelectionRange(end, end);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => save(e.currentTarget.value)}
    />
  );
}
