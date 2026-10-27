import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolver } from './models.ts';

const seen = [
  { model: 'claude-sonnet-5-5', effort: 'low' },
  { model: 'claude-opus-5-5', effort: 'high' },
];

test('the default model is the settings one, with an alias read as the model sessions ran', () => {
  const r = resolver({ model: 'opus[1m]', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } }, seen);
  assert.equal(r.model, 'claude-opus-5-5[1m]');
  assert.equal(r.effortOf(r.model), 'medium', 'the effort set for that model');
  assert.equal(r.real('sonnet'), 'claude-sonnet-5-5');
  assert.equal(r.real('haiku'), 'haiku', 'an alias no session ran stays as given');
  assert.equal(r.effortOf('claude-sonnet-5-5'), 'low', 'without a setting, the effort a session of that model ran with');
});

test('without a model in the settings, the default is the one the newest session ran', () => {
  const r = resolver({ effortLevel: 'xhigh' }, seen);
  assert.equal(r.model, 'claude-sonnet-5-5');
  assert.equal(r.effortOf(r.model), 'xhigh');
  assert.deepEqual([resolver({}, []).model, resolver({}, []).effortOf(null)], [null, null]);
});
