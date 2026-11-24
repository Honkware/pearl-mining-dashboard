// Pacing requests to the public node's token bucket.
import { expect, test } from 'vitest';
import { costOf, pacedFetch } from '../src/pace.js';

test('calls are charged what the public node charges', () => {
  expect(costOf(JSON.stringify({ method: 'getblockhash', params: [1] }))).toBe(1);
  expect(costOf(JSON.stringify({ method: 'getblock', params: ['h', 0] }))).toBe(3);
  expect(costOf(JSON.stringify({ method: 'getblock', params: ['h', 2] }))).toBe(9);
  expect(costOf(JSON.stringify([{ method: 'getblockcount' }, { method: 'getrawmempool' }]))).toBe(3);
});

test('requests past the bucket wait for it to refill', async () => {
  let clock = 0;
  const waits: number[] = [];
  const f = pacedFetch({
    rate: 2,
    burst: 4,
    now: () => clock,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    fetch: (async () => new Response('{}')) as typeof fetch,
  });
  const block = { method: 'POST', body: JSON.stringify({ method: 'getblock', params: ['h', 0] }) };
  await f('x', block);
  await f('x', block);
  // 4 - 3 leaves 1 token; the second getblock needs 2 more, a second at 2 a second.
  expect(waits).toEqual([1000]);
});
