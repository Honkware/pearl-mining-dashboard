// Naming pools from their published data, against a simulated chain.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { customNetwork, networks, toOutputScript } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import { Store } from '../src/db.js';
import { startIndexer } from '../src/indexer.js';
import { collectPools, type PoolSource, type TrackerSource } from '../src/pools.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const hex = (a: string): string => Buffer.from(toOutputScript(a, net)).toString('hex');

test('pools are named by their own data first, then by trackers, and a contested address by nobody', async () => {
  const chain = new SimulatedChain({ network: net, premine: 3 });
  const a = testAddress(30, net);
  const b = testAddress(31, net);
  const shared = testAddress(32, net);
  const mined = (to: string): string => chain.mine(1, { coinbaseTo: to })[0]!.hash;
  const aHashes = [mined(a), mined(a), mined(shared)];
  mined(b);
  const dir = mkdtempSync(join(tmpdir(), 'pmd-pools-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;

  const bodies: Record<string, unknown> = {
    'https://a.test/blocks': { hashes: [...aHashes, 'ff'.repeat(32)], hashrate: 40, net: 100 },
    'https://b.test/wallet': { address: b },
    'https://c.test/blocks': { hashes: [aHashes[2]] },
    'https://t.test/pairs': [{ pool: 'Pool B', address: a }, { pool: 'pool b', address: testAddress(33, net) }, { pool: 'Pool E', address: testAddress(34, net) }],
  };
  const fake = (async (url: string) => {
    if (url === 'https://d.test/down') return new Response('nope', { status: 503 });
    return new Response(JSON.stringify(bodies[url]), { status: 200 });
  }) as typeof fetch;
  const pools: PoolSource[] = [
    { label: 'Pool A', site: 'https://a.test', urls: ['https://a.test/blocks'], parse: ([x]) => ({ blockHashes: x.hashes, claim: { hashrate: x.hashrate, networkHashrate: x.net } }) },
    { label: 'Pool B', site: 'https://b.test', urls: ['https://b.test/wallet'], parse: ([x]) => ({ wallet: x.address }) },
    { label: 'Pool C', site: 'https://c.test', urls: ['https://c.test/blocks'], parse: ([x]) => ({ blockHashes: x.hashes }) },
    { label: 'Pool D', site: 'https://d.test', urls: ['https://d.test/down'], parse: () => ({}) },
  ];
  const trackers: TrackerSource[] = [{ name: 'tracker.test', urls: ['https://t.test/pairs'], parse: ([x]) => x }];
  const run = await collectPools({ store, network: net, dataDir: dir, now: chain.time, fetch: fake, pools, trackers });

  const byLabel = new Map(run.labels.filter((l) => !l.source.startsWith('tracker.test')).map((l) => [l.label, l]));
  expect(byLabel.get('Pool A')!.scripts).toEqual([hex(a)]);
  const fromTracker = run.labels.filter((l) => l.source.startsWith('tracker.test'));
  expect(fromTracker.map((l) => [l.label, l.scripts])).toEqual([['Pool B', [hex(testAddress(33, net))]], ['Pool E', [hex(testAddress(34, net))]]]);
  expect(byLabel.get('Pool A')!.source).toContain('3 of 4 published block hashes');
  expect(byLabel.get('Pool B')!.scripts).toEqual([hex(b)]);
  expect(byLabel.has('Pool C')).toBe(false);
  expect(run.conflicts).toEqual([{ script: hex(shared), pools: ['Pool A', 'Pool C'] }]);
  expect(run.results.find((r) => r.label === 'Pool D')!.error).toContain('503');
  expect(run.claims).toEqual([{ label: 'Pool A', hashrate: 40, networkHashrate: 100, readAt: chain.time, source: 'https://a.test' }]);
  store.close();
});
