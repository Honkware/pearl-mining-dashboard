// Pool names proven by a signature from the address, verified with pearljs.
import { expect, test } from 'vitest';
import { keyPathAddress, networks, signMessage } from 'pearljs';
import { testKey } from 'pearljs/testing';
import { parseSignedNames, proofMessage } from '../src/labels.js';

const net = networks.mainnet;
const key = testKey(3);
const address = keyPathAddress(key, net);

test('a name signed by its address is taken, and the same signature under another pool name is not', () => {
  const signature = signMessage(key, proofMessage('Example Pool'));
  const doc = JSON.stringify({ names: [
    { pool: 'Example Pool', address, signature },
    { pool: 'Someone Else', address, signature },
  ] });
  const { labels, rejected } = parseSignedNames(doc, net);
  expect(labels.entries.map((e) => [e.label, e.source])).toEqual([['Example Pool', 'signed by the address']]);
  expect(rejected.map((r) => r.pool)).toEqual(['Someone Else']);
});
