import { clock, useNow } from '../now.ts';

export function Clock({ since }: { since: number }) {
  return <>{clock(since, useNow())}</>;
}
