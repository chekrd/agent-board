import type { Advice, Menu, Question, QuestionOption, Session, Summary } from './types.ts';

// Sessions for the web tests, in the snapshot's shape.

export const session = (id: string, patch: Partial<Session> = {}): Session => ({
  id, conversation: id, history: [], repoId: 1, worktree: `/w/${id}`, cwd: `/w/${id}`, pid: 1, tty: '/dev/ttys001', title: id, firstPrompt: null, status: 'idle',
  question: null, rank: null, rankReason: null, priority: null, diffstat: null, lastMessage: null, lastPrompt: null, lastTurn: 't1', waitingFor: null,
  dismissedAsk: null, advice: null, prs: [], summary: null, explanation: null, activity: null, menu: null, answered: null, artifacts: [], links: [], findings: null, parent: null, resolution: null, model: null, effort: null, archived: false,
  createdAt: 0, updatedAt: 0, ...patch,
});

export const options = (...labels: string[]): QuestionOption[] => labels.map((label) => ({ label }));

export const question = (toolUseId: string, choices = options('Keep', 'Merge'), askedAt = 1): Question =>
  ({ toolUseId, title: 'Which cart wins?', details: 'd', options: choices, category: 'product decision', askedAt });

// An end-of-turn decision read from the turn `basis`; the session needs lastTurn: basis and status idle.
export const turn = (basis: string, choices = options('Ship', 'Wait'), at = 1): Summary =>
  ({ text: 'Tests pass.', basis, at, question: null, decision: { problem: 'Ship it?', brief: 'Tests pass.', options: choices } });

export const menu = (toolUseId: string, ...questions: Menu['questions']): Menu => ({
  toolUseId, at: 1,
  questions: questions.length ? questions : [
    { question: 'Backoff?', header: 'Backoff', multiSelect: false, options: options('Exponential', 'Linear') },
    { question: 'Then?', header: 'Give up', multiSelect: true, options: options('Email', 'Disable', 'Log') },
  ],
});

export const advice = (key: string, patch: Partial<Advice> = {}): Advice =>
  ({ key, state: 'done', startedAt: 1, activity: null, choice: null, answer: 'Because it is smaller.', confidence: 80, reasoning: 'r', at: 7, ...patch });
