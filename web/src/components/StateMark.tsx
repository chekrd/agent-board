import type { CSSProperties } from 'react';
import type { Attention } from '../util.ts';
import styles from './StateMark.module.css';

export function StateMark({ state, size = 9 }: { state: Attention | 'archived'; size?: number }) {
  return <span className={styles.mark} data-state={state} style={{ '--size': `${size}px` } as CSSProperties} aria-hidden />;
}
