import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseUsage } from './usage.ts';

test('the status line copy of rate_limits gives both windows, their reset times in ms', () => {
  const text = JSON.stringify({
    at: 1_792_000_000_000,
    rate_limits: { five_hour: { used_percentage: 34.6, resets_at: 1_792_003_600 }, seven_day: { used_percentage: 61, resets_at: 1_792_200_000 } },
  });
  assert.deepEqual(parseUsage(text), {
    fiveHour: { percent: 34.6, resetsAt: 1_792_003_600_000 },
    sevenDay: { percent: 61, resetsAt: 1_792_200_000_000 },
    at: 1_792_000_000_000,
  });
});

test('a window without a percentage is left out, one without a reset time keeps its percentage; no time of reading is the time of the read', () => {
  const text = JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12 }, seven_day: { resets_at: 9 } } });
  assert.deepEqual(parseUsage(text, 5), { fiveHour: { percent: 12, resetsAt: null }, sevenDay: null, at: 5 });
});

test('no windows, no rate_limits or a half-written file give no reading', () => {
  for (const text of ['{"at":1,"rate_limits":{}}', '{"at":1,"rate_limits":null}', '{"at":1}', '{"at":1,"rate_lim', '']) {
    assert.equal(parseUsage(text), null, text);
  }
});
