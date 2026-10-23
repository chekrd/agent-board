import { api, sessionAction } from '../api.ts';
import { go, sessionPath } from '../router.ts';
import type { RepoView, Session } from '../types.ts';
import { locate, sessionLabel } from '../util.ts';
import { AnswerForm } from './AnswerForm.tsx';
import styles from './Detail.module.css';
import { DiffView } from './DiffView.tsx';
import { Markdown } from './Markdown.tsx';
import { DiffStat, StatusChip } from './Status.tsx';
import { TerminalView } from './TerminalView.tsx';

interface Props {
  session: Session;
  sessions: Session[];
  repos: RepoView[];
  tab: string;
}

export function Detail({ session, sessions, repos, tab }: Props) {
  const { repo, branch } = locate(repos, session);
  const shells = sessions.filter((s) => s.kind === 'shell' && s.worktree === session.worktree);
  const tabs = [
    ...(session.kind === 'claude' ? [{ key: 'details', label: session.question ? 'Question' : 'Details' }] : []),
    { key: 'terminal', label: session.kind === 'claude' ? 'Claude' : 'Shell' },
    { key: 'diff', label: 'Diff' },
    ...shells.filter((s) => s.id !== session.id).map((s, i) => ({ key: s.id, label: s.title || `Shell ${i + 1}` })),
  ];
  const current = tabs.some((t) => t.key === tab) ? tab : tabs[0].key;
  const shell = shells.find((s) => s.id === current);

  const newShell = async () => {
    const { id } = await api<{ id: string }>('POST', '/api/sessions', { repoId: session.repoId, worktree: session.worktree, kind: 'shell' });
    go(sessionPath(session.id, id));
  };

  return (
    <div className={styles.detail}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2>{sessionLabel(session, branch)}</h2>
          <div className={styles.meta}>
            <span>{repo?.name} · {branch} · base {repo?.base}</span>
            <DiffStat stat={session.diffstat} />
            <StatusChip status={session.status} />
          </div>
        </div>
        <div className={styles.actions}>
          {session.status === 'exited' && session.kind === 'claude' && (
            <button data-variant="primary" onClick={() => sessionAction(session.id, 'resume').catch(reportError)}>Resume</button>
          )}
          <button onClick={() => sessionAction(shell?.id ?? session.id, 'ghostty').catch(reportError)}>Open in Ghostty</button>
        </div>
      </header>
      <nav className={styles.tabs}>
        {tabs.map((t) => (
          <a key={t.key} href={sessionPath(session.id, t.key)} aria-current={t.key === current ? 'page' : undefined}>
            {t.label}
          </a>
        ))}
        <button data-variant="ghost" onClick={() => newShell().catch(reportError)} title="New shell in this worktree">+ shell</button>
        {shell && (
          <button data-variant="ghost" className={styles.closeShell} onClick={() => sessionAction(shell.id, 'stop').then(() => go(sessionPath(session.id, 'terminal')))}>
            Close shell
          </button>
        )}
      </nav>
      <div className={styles.body}>
        {current === 'details' && <Overview session={session} />}
        {current === 'terminal' && <TerminalView key={`${session.id}:${session.status === 'exited'}`} sessionId={session.id} disconnected={session.status === 'exited'} />}
        {current === 'diff' && <DiffView worktree={session.worktree} />}
        {shell && <TerminalView key={shell.id} sessionId={shell.id} />}
      </div>
    </div>
  );
}

function Overview({ session }: { session: Session }) {
  const q = session.question;
  return (
    <div className={styles.overview}>
      {q ? (
        <section className={styles.question}>
          <div className={styles.questionMeta}>
            {session.rank && <strong>#{session.rank}</strong>} {q.category}
            {session.rankReason && <em> — {session.rankReason}</em>}
          </div>
          <h3>{q.title}</h3>
          <Markdown source={q.details} />
          <AnswerForm session={session} />
        </section>
      ) : (
        <p className={styles.none}>No open question. Claude will raise one here when it needs you.</p>
      )}
      <dl className={styles.facts}>
        <dt>Task</dt>
        <dd>{session.firstPrompt ?? '—'}</dd>
        <dt>Worktree</dt>
        <dd><code>{session.worktree}</code></dd>
        <dt>Session</dt>
        <dd><code>{session.id}</code></dd>
      </dl>
    </div>
  );
}
