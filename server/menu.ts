import type { Menu } from './conversations.ts';
import type { Keystroke } from './ghostty.ts';

export interface MenuAnswer {
  labels: string[];
  other: string;
}

// Drives Claude Code's AskUserQuestion dialog. Each question opens with the cursor on its first
// option; a single choice moves on as soon as it is picked, a multiple choice needs Tab, and
// with more than one question (or a multiple choice) a review step needs one more Enter.
export function menuKeystrokes(menu: Menu, answers: MenuAnswer[]) {
  if (answers?.length !== menu.questions.length) throw new Error('answer every question');
  const strokes: Keystroke[] = [];
  const down = (n: number) => strokes.push(...Array.from({ length: n }, () => ({ key: 'arrow_down' })));
  menu.questions.forEach((q, i) => {
    const a = answers[i];
    // Typed into a one-line field, where a newline would be Enter and a tab Tab.
    const other = a.other?.replace(/\s+/g, ' ').trim() ?? '';
    const picked = a.labels.map((l) => q.options.findIndex((o) => o.label === l));
    if (picked.includes(-1)) throw new Error(`unknown option for "${q.question}"`);
    if (q.multiSelect) {
      if (other) throw new Error('a multiple-choice question takes only its options here; write anything else in the terminal');
      if (!picked.length) throw new Error(`pick at least one option for "${q.question}"`);
      let cursor = 0;
      for (const index of picked.toSorted((x, y) => x - y)) {
        down(index - cursor);
        strokes.push({ key: 'enter' });
        cursor = index;
      }
      strokes.push({ key: 'tab' });
    } else if (other) {
      down(q.options.length);
      strokes.push({ text: other }, { key: 'enter' });
    } else {
      if (picked.length !== 1) throw new Error(`pick one option for "${q.question}"`);
      down(picked[0]);
      strokes.push({ key: 'enter' });
    }
  });
  if (menu.questions.length > 1 || menu.questions[0].multiSelect) strokes.push({ key: 'enter' });
  return strokes;
}
