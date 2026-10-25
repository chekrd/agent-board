import { showTab } from '../router.ts';
import type { Session } from '../types.ts';
import { ago } from '../util.ts';
import styles from './Artifacts.module.css';
import { Icon } from './Icon.tsx';

export const artifactUrl = (sessionId: string, id: string) => `/api/sessions/${sessionId}/artifacts/${id}`;

export function Artifacts({ session, item }: { session: Session; item: string | null }) {
  const list = session.artifacts.toReversed();
  const shown = list.find((a) => a.id === item) ?? list[0];
  if (!shown) return <p className={styles.empty}>Claude has not made any artifacts in this session.</p>;
  return (
    <div className={styles.artifacts}>
      <div className={styles.list} role="tablist" aria-label="Artifacts" aria-orientation="vertical">
        {list.map((a) => (
          <button key={a.id} type="button" role="tab" aria-selected={a.id === shown.id} onClick={() => showTab('artifacts', a.id)}>
            <strong>{a.title}</strong>
            <span>made {ago(a.at)}</span>
          </button>
        ))}
      </div>
      <div className={styles.viewer} role="tabpanel">
        <header>
          <strong>{shown.title}</strong>
          <span>made {ago(shown.at)}</span>
          <a href={artifactUrl(session.id, shown.id)} target="_blank" rel="noreferrer">
            Open in new tab <Icon name="external" size={14} />
          </a>
        </header>
        <iframe key={shown.id} className={styles.frame} title={shown.title} src={artifactUrl(session.id, shown.id)} sandbox="allow-scripts" />
      </div>
    </div>
  );
}
