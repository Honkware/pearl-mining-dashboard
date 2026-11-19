// pearljs's block checks run on every indexed block.
import { expect, test } from 'vitest';
import { customNetwork, networks, parseBlock } from 'pearljs';
import { SimulatedChain } from 'pearljs/testing';
import { checkBlock } from '../src/facts.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });

test('every block of a simulated chain passes, and a changed Merkle root is caught', async () => {
  const chain = new SimulatedChain({ network: net, premine: 6 });
  for (let h = 1; h <= chain.height; h++) {
    const raw = await chain.rpc.getRawBlock(chain.blocks[h]!.hash);
    expect(checkBlock(parseBlock(raw), h, net)).toBeNull();
  }
  const block = parseBlock(await chain.rpc.getRawBlock(chain.tip.hash));
  block.header.merkleRoot = new Uint8Array(32).fill(7);
  expect(checkBlock(block, chain.height, net)).toMatch(/^checkMerkleRoot: /);
});
