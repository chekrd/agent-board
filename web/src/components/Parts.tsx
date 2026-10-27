import type { ReactNode } from 'react';
import { useNow } from '../now.ts';
import type { Session } from '../types.ts';
import { ago } from '../util.ts';
import { Markdown } from './Markdown.tsx';
import parts from './Parts.module.css';

// The card's headline steps down in size as it grows longer.
export function Headline({ text }: { text: string }) {
  const length = text.length <= 64 ? 'short' : text.length <= 96 ? 'medium' : 'long';
  return <h1 className={parts.headline} data-length={length}>{text}</h1>;
}

// The branch before a task's name, so a generated title still says which work it is. A task named after its branch
// has it already.
export function BranchMark({ session, branch }: { session: Session; branch: string }) {
  if (!branch || !session.title || session.title === branch) return null;
  return <span className={parts.branch} data-branch title="Branch">{branch}</span>;
}

export function Age({ at, prefix = '' }: { at: number; prefix?: string }) {
  return <>{prefix}{ago(at, useNow())}</>;
}

// One of the card's two columns; the card scrolls both together.
export function Column({ side, children }: { side: 'left' | 'right'; children: ReactNode }) {
  return <div className={parts.column} data-side={side}>{children}</div>;
}

export function Progress({ items, quiet = false }: { items: readonly string[]; quiet?: boolean }) {
  if (!items.length) return null;
  return (
    <section className={parts.progress} data-quiet={quiet || undefined}>
      <h3 className={parts.label} title="A short summary of the session, rewritten by a model after each of Claude's messages">Status</h3>
      <ul>{items.map((p) => <li key={p}>{p}</li>)}</ul>
    </section>
  );
}

export function LatestReply({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <section className={parts.reply}>
      <h3 className={parts.label}>Claude's latest reply</h3>
      <div className={parts.body}><Markdown source={text} /></div>
    </section>
  );
}
