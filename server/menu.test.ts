import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MenuQuestion } from './conversations.ts';
import { menuKeystrokes } from './menu.ts';

const question = (multiSelect = false): MenuQuestion => ({
  question: 'Colour?',
  header: 'Colour',
  multiSelect,
  options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }],
});
const menu = (...questions: MenuQuestion[]) => ({ toolUseId: 't', questions, at: 0 });
const keys = (...names: string[]) => names.map((key) => ({ key }));

test('a lone single choice moves down to it and submits with Enter', () => {
  assert.deepEqual(menuKeystrokes(menu(question()), [{ labels: ['Blue'], other: '' }]), keys('arrow_down', 'arrow_down', 'enter'));
});

test('own text goes below the options, then Enter', () => {
  assert.deepEqual(menuKeystrokes(menu(question()), [{ labels: [], other: ' Purple ' }]), [
    ...keys('arrow_down', 'arrow_down', 'arrow_down'),
    { text: 'Purple' },
    { key: 'enter' },
  ]);
});

test('own text is one line: a newline or a tab in it would be Enter or Tab in the dialog', () => {
  assert.deepEqual(menuKeystrokes(menu(question()), [{ labels: [], other: 'Purple,\n\tor violet ' }]).at(-2), { text: 'Purple, or violet' });
});

test('multiple choice toggles in order, Tab moves on, and the review step needs Enter', () => {
  assert.deepEqual(menuKeystrokes(menu(question(true)), [{ labels: ['Blue', 'Red'], other: '' }]), keys('enter', 'arrow_down', 'arrow_down', 'enter', 'tab', 'enter'));
});

test('two questions end with the review Enter', () => {
  assert.deepEqual(
    menuKeystrokes(menu(question(), question()), [{ labels: ['Red'], other: '' }, { labels: ['Green'], other: '' }]),
    keys('enter', 'arrow_down', 'enter', 'enter'),
  );
});

test('refuses answers it cannot type', () => {
  assert.throws(() => menuKeystrokes(menu(question()), []), /answer every question/);
  assert.throws(() => menuKeystrokes(menu(question()), [{ labels: ['Pink'], other: '' }]), /unknown option/);
  assert.throws(() => menuKeystrokes(menu(question(true)), [{ labels: ['Red'], other: 'x' }]), /multiple-choice/);
  assert.throws(() => menuKeystrokes(menu(question(true)), [{ labels: [], other: '' }]), /at least one/);
  assert.throws(() => menuKeystrokes(menu(question()), [{ labels: ['Red', 'Blue'], other: '' }]), /pick one/);
});
