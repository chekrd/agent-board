import { promptOf } from '../deck.ts';
import type { Session } from '../types.ts';
import card from './Card.module.css';
import { Column, Headline, LatestReply, Progress } from './Parts.tsx';
import styles from './PromptBody.module.css';

// Needs focus: Claude shows a prompt in its terminal that only the terminal can answer.
export function PromptBody({ session }: { session: Session }) {
  const { headline, subject } = promptOf(session);
  return (
    <div className={card.cols}>
      <Column side="left">
        <Headline text={headline} />
        {session.summary?.text && <p className={card.lead}>{session.summary.text}</p>}
        <Progress items={session.summary?.progress ?? []} />
        <LatestReply text={session.lastMessage} />
      </Column>
      <Column side="right">
        <div className={styles.plate}>
          <span className={styles.caption}>Claude’s terminal{session.tty ? ` · ${session.tty}` : ''}</span>
          {subject && <code className={styles.subject}>{subject}</code>}
        </div>
        <p className={styles.explain}>
          Only the terminal can answer this. Terminal opens its Ghostty tab, or switches to it; the card clears once Claude moves on.
        </p>
      </Column>
    </div>
  );
}
