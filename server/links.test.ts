import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linksIn, mergeLinks } from './links.ts';

test('links in a message: a Markdown link keeps its text, a bare one loses the punctuation after it, each once', () => {
  const message = [
    'Opened [PR #42](https://github.com/o/r/pull/42) for the fix.',
    'It is tracked in https://github.com/o/r/issues/7. See also (https://react.dev/reference/react/Suspense), **https://x.dev/a?b=1**',
    'Again: https://github.com/o/r/pull/42 and `https://example.com/path`',
  ].join('\n');
  assert.deepEqual(linksIn(message, 5).map((l) => [l.url, l.text]), [
    ['https://github.com/o/r/pull/42', 'PR #42'],
    ['https://github.com/o/r/issues/7', null],
    ['https://react.dev/reference/react/Suspense', null],
    ['https://x.dev/a?b=1', null],
    ['https://example.com/path', null],
  ]);
  const [pr] = linksIn(message, 5);
  assert.deepEqual([pr.context, pr.at], ['Opened [PR #42](https://github.com/o/r/pull/42) for the fix.', 5]);
});

test('merging keeps the links seen before as they are and adds only new ones, undescribed', () => {
  const kept = [{ url: 'https://a.dev', text: null, context: 'a', about: 'The a docs', at: 1 }];
  assert.equal(mergeLinks(kept, [{ url: 'https://a.dev', text: 'A', context: 'again', at: 9 }]), null);
  assert.deepEqual(mergeLinks(kept, [{ url: 'https://b.dev', text: null, context: 'b', at: 2 }, { url: 'https://b.dev', text: null, context: 'b', at: 3 }]), [
    ...kept, { url: 'https://b.dev', text: null, context: 'b', about: null, at: 2 },
  ]);
});
