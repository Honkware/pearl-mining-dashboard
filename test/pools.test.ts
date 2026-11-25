// Naming pools from their published data, against a simulated chain.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { customNetwork, networks, toOutputScript } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import { Store } from '../src/db.js';
import { startIndexer } from '../src/indexer.js';
import { POOLS, collectPools, type PoolSource, type TrackerSource } from '../src/pools.js';

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

test('an address whose coinbase is spent with a named one takes its name, unless the group holds two names', async () => {
  const { testAccount } = await import('pearljs/testing');
  const { payFromAccount } = await import('pearljs');
  const { linkBySpending } = await import('../src/pools.js');
  const chain = new SimulatedChain({ network: net, premine: 3 });
  const account = testAccount(0, net);
  const addr = [0, 1, 2, 3].map((i) => account.deriveAddress(i));
  const coin = addr.map((a) => chain.mine(1, { coinbaseTo: a })[0]!.hash);
  chain.mine(3);
  const spend = (idx: number[]): void => {
    const utxos = idx.map((i) => {
      const tx = chain.block(coin[i]!)!.txs[0]!;
      return { txid: tx.getId(), vout: 0, index: i, value: tx.outs[0]!.value, script: toOutputScript(addr[i]!, net), address: addr[i]!, confirmations: 4, coinbase: true };
    });
    chain.accept(payFromAccount(account, { network: net, utxos, recipients: [{ address: testAddress(5, net), amount: 'max' }], feeRate: 2000n, coinbaseMaturity: net.coinbaseMaturity }).transaction);
    chain.mine(1);
  };
  spend([0, 1]);
  spend([2, 3]);
  const dir = mkdtempSync(join(tmpdir(), 'pmd-link-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;

  const one = linkBySpending(store, [{ label: 'Pool A', scripts: [hex(addr[0]!)], source: 'test' }], 'd');
  expect(one.added).toEqual([{ label: 'Pool A', scripts: [hex(addr[1]!)], source: "coinbases spent together with Pool A's, read d" }]);

  const two = linkBySpending(store, [{ label: 'Pool A', scripts: [hex(addr[2]!)], source: 't' }, { label: 'Pool B', scripts: [hex(addr[3]!)], source: 't' }], 'd');
  expect(two.added).toEqual([]);
  expect(two.clashes).toEqual([['Pool A', 'Pool B']]);
  store.close();
});

test("F2Pool's hashrate and the network's are read from its homepage row", async () => {
  const { POOLS } = await import('../src/pools.js');
  const f2 = POOLS.find((p) => p.label === 'F2Pool')!;
  // Trimmed from https://www.f2pool.com/ as served on 2026-11-19.
  const row = '<tr><td><span>PRL</span><span>Pearl"></span> PRL + NOCK</td><td>$ 0.0173 /T</td><td>3956.91 PH/s</td><td>103.69 EH/s</td></tr>';
  const claim = f2.parse([row]).claim!;
  expect(claim.hashrate).toBeCloseTo(3956.91e15, -10);
  expect(claim.networkHashrate).toBeCloseTo(103.69e18, -13);
});

test("a pool's own fee comes first, and a tracker's only fills in for pools that publish none", async () => {
  const chain = new SimulatedChain({ network: net, premine: 3 });
  const dir = mkdtempSync(join(tmpdir(), 'pmd-pools-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;
  const bodies: Record<string, unknown> = {
    'https://a.test/stats': { fee: 2, mode: 'pplns' },
    'https://b.test/stats': {},
    'https://t.test/pools': [{ name: 'pool a', fee: 1, scheme: 'PROP' }, { name: 'Pool B', fee: 0.5, scheme: 'PPS' }, { name: 'Pool B', fee: 9, scheme: 'PPS' }],
  };
  const fake = (async (url: string) => new Response(JSON.stringify(bodies[url]), { status: 200 })) as typeof fetch;
  const pools: PoolSource[] = [
    { label: 'Pool A', site: 'https://a.test', urls: ['https://a.test/stats'], parse: ([x]) => ({ fees: [{ scheme: x.mode.toUpperCase(), pct: x.fee }] }) },
    { label: 'Pool B', site: 'https://b.test', urls: ['https://b.test/stats'], parse: () => ({}) },
  ];
  const trackers: TrackerSource[] = [{ name: 'tracker.test', urls: ['https://t.test/pools'], parse: () => [], fees: ([x]) => x.map((p: { name: string; fee: number; scheme: string }) => ({ pool: p.name, terms: [{ scheme: p.scheme, pct: p.fee }] })) }];
  const run = await collectPools({ store, network: net, dataDir: dir, now: chain.time, fetch: fake, pools, trackers });
  expect(run.fees).toEqual([
    { label: 'Pool A', terms: [{ scheme: 'PPLNS', pct: 2 }], readAt: chain.time, source: 'https://a.test' },
    { label: 'Pool B', terms: [{ scheme: 'PPS', pct: 0.5 }], readAt: chain.time, source: 'tracker.test' },
  ]);
  store.close();
});

test("Kryptex's commission fractions are read as one fee per mode", () => {
  const kryptex = POOLS.find((p) => p.label === 'Kryptex')!;
  const pages = kryptex.urls.slice(0, -1).map(() => ({ results: [] }));
  const e = kryptex.parse([...pages, { hashrate: 1, net_hashrate: 2, fee_type: 'PPS+', fee: 0.03, commission: { 'PPS+': 0.03, SOLO: 0.01 } }]);
  expect(e.fees).toEqual([{ scheme: 'PPS+', pct: 3 }, { scheme: 'SOLO', pct: 1 }]);
});
