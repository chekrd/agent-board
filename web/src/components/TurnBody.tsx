import type { Session } from '../types.ts';
import card from './Card.module.css';
import { Composer } from './Composer.tsx';
import type { ComposerHooks } from './DecisionBody.tsx';
import { Findings } from './Findings.tsx';
import { Column, Headline, LatestReply } from './Parts.tsx';
import { PrChip, prKey } from './Status.tsx';
import styles from './TurnBody.module.css';

// Your turn: Claude finished its turn and waits for the next message.
export function TurnBody({ session, composer }: { session: Session; composer: ComposerHooks }) {
  // The findings are what the latest reply says, there one by one to answer.
  const listed = !!session.findings?.items.length && session.findings.basis === session.lastTurn;
  return (
    <div className={card.cols}>
      <Column side="left">
        <Headline text={session.summary?.text || 'Claude finished its turn'} />
        {listed ? <Findings session={session} compact /> : <LatestReply text={session.lastMessage} />}
      </Column>
      <Column side="right">
        {session.prs.map((pr) => {
          const failed = pr.result?.startsWith('FAILED') ? pr.result.split(': ').slice(1).join(': ') : '';
          return (
            <div key={prKey(pr)} className={styles.pr}>
              <PrChip pr={pr} status={session.status} />
              {failed && <code>{failed}</code>}
            </div>
          );
        })}
        <Composer session={session} decision={null} label="Message Claude" placeholder="Reply, / for commands, paste or drop files…" {...composer} />
      </Column>
    </div>
  );
}
