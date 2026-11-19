// The indexer against a real pearld on regtest. Blocks come from a file of
// saved blocks and go in with submitblock, so nothing has to be proved here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startRegtest, type Regtest } from 'pearljs/testing-regtest';
import { Store } from '../src/db.js';
import { startIndexer } from '../src/indexer.js';
import { miners, network as networkStats, stale, type Context } from '../src/analysis.js';
import { emptyLabels } from '../src/labels.js';

let regtest: Regtest;
let dir: string;
let saved: string[];

beforeAll(async () => {
  const pearld = process.env.PEARLD;
  const chain = process.env.PEARL_CHAIN;
  if (pearld === undefined || chain === undefined) throw new Error('set PEARLD and PEARL_CHAIN');
  saved = JSON.parse(readFileSync(chain, 'utf8')) as string[];
  regtest = await startRegtest({ pearld, indexes: false });
  for (const block of saved) await regtest.node.call('submitblock', [block]);
  dir = mkdtempSync(join(tmpdir(), 'pmd-live-'));
});

afterAll(async () => {
  await regtest?.stop();
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

test('indexes a real node and follows an invalidated tip off and back on', async () => {
  const store = new Store(join(dir, 'regtest.sqlite'));
  const ctx: Context = { store, network: regtest.network, labels: emptyLabels(), claims: [] };
  await startIndexer({ store, rpc: regtest.node, network: regtest.network, stopAtTip: true }).done;
  const tip = await regtest.node.getBestBlock();
  expect(tip.height).toBe(saved.length);
  expect(store.tipHeight()).toBe(saved.length);

  const rows = miners(ctx, 'all');
  // The saved chain was mined to one address of its own.
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toMatch(/^rprl1p/);
  expect(rows[0]!.blocks).toBe(saved.length);
  const net = networkStats(ctx, 'all')!;
  expect(net.blocks).toBe(saved.length);
  expect(net.difficulty).toBeGreaterThan(0);

  await regtest.node.call('invalidateblock', [tip.hash]);
  await startIndexer({ store, rpc: regtest.node, network: regtest.network, stopAtTip: true }).done;
  expect(store.tipHeight()).toBe(saved.length - 1);
  expect(stale(ctx).map((s) => s.hash)).toContain(tip.hash);

  await regtest.node.call('reconsiderblock', [tip.hash]);
  await startIndexer({ store, rpc: regtest.node, network: regtest.network, stopAtTip: true }).done;
  expect(store.tipHeight()).toBe(saved.length);
  store.close();
});
