import { sessionPath } from '../router.ts';
import type { Session } from '../types.ts';
import { ago } from '../util.ts';
import styles from './Artifacts.module.css';

export const artifactUrl = (sessionId: string, id: string) => `/api/sessions/${sessionId}/artifacts/${id}`;

export function Artifacts({ session, item }: { session: Session; item: string | null }) {
  const list = session.artifacts.toReversed();
  const shown = list.find((a) => a.id === item) ?? list[0];
  if (!shown) return <p className={styles.empty}>Claude has not made any artifacts in this session.</p>;
  return (
    <div className={styles.artifacts}>
      <nav className={styles.bar}>
        {list.map((a) => (
          <a key={a.id} href={sessionPath(session.id, 'artifacts', a.id)} aria-current={a.id === shown.id ? 'page' : undefined} title={`Made ${ago(a.at)}`}>
            {a.title}
          </a>
        ))}
        <a className={styles.external} href={artifactUrl(session.id, shown.id)} target="_blank" rel="noreferrer">Open in new tab ↗</a>
      </nav>
      <iframe key={shown.id} className={styles.frame} title={shown.title} src={artifactUrl(session.id, shown.id)} sandbox="allow-scripts" />
    </div>
  );
}

export function ArtifactLinks({ session }: { session: Session }) {
  return (
    <ul className={styles.links}>
      {session.artifacts.toReversed().map((a) => (
        <li key={a.id}>
          <a href={sessionPath(session.id, 'artifacts', a.id)}>{a.title}</a> <span>{ago(a.at)}</span>
        </li>
      ))}
    </ul>
  );
}
