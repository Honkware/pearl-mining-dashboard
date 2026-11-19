// The pages and the JSON API served over a small simulated chain.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { customNetwork, networks } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import type { Server } from 'node:http';
import { Store } from '../src/db.js';
import { startIndexer } from '../src/indexer.js';
import { createApp } from '../src/server.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
let dir: string;
let store: Store;
let server: Server;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pmd-srv-'));
  const chain = new SimulatedChain({ network: net, premine: 3 });
  for (let i = 0; i < 60; i++) chain.mine(1, { coinbaseTo: testAddress(i % 3 === 0 ? 20 : 21, net) });
  store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;
  writeFileSync(join(dir, 'labels.json'), JSON.stringify({ identities: [{ label: 'Big pool', scripts: [testAddress(21, net)], source: 'test' }] }));
  writeFileSync(join(dir, 'claims.json'), JSON.stringify({ claims: [{ label: 'Big pool', share: 0.95, readAt: chain.time, source: 'its own page' }] }));
  server = createApp({ store, network: net, dataDir: dir, port: 0, host: '127.0.0.1', now: () => chain.time });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

test('the overview lists the labelled pool first and flags a claim the chain does not support', async () => {
  const html = await (await fetch(`${base}/?window=all`)).text();
  expect(html).toContain('Big pool');
  expect(html.indexOf('Big pool')).toBeLessThan(html.indexOf(testAddress(20, net).slice(0, 10)));
  expect(html).toContain('too high');
});

test('a miner page marks a claim above what the pool found as too high', async () => {
  const res = await fetch(`${base}/miner/${encodeURIComponent('label:Big pool')}?window=all`);
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('tag off">too high');
});

test('the miners API counts every block once', async () => {
  const body = (await (await fetch(`${base}/api/miners.json?window=all`)).json()) as { blocks: number; miners: { blocks: number }[] };
  expect(body.miners.reduce((s, m) => s + m.blocks, 0)).toBe(body.blocks);
});

test('unknown pages and miners are 404', async () => {
  expect((await fetch(`${base}/nope`)).status).toBe(404);
  expect((await fetch(`${base}/miner/script%3Aabcd`)).status).toBe(404);
});

test('the tip endpoint names the newest block, which the page carries for its refresh check', async () => {
  const tip = (await (await fetch(`${base}/api/tip.json`)).json()) as { height: number; hash: string };
  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain(`data-tip="${tip.hash}"`);
  expect(tip.height).toBe(63); // 3 premined, then 60
});

test('the miners page finds a pool by name and keeps its overall rank', async () => {
  const html = await (await fetch(`${base}/miners?window=all&q=big`)).text();
  expect(html).toContain('Big pool');
  expect(html).toContain('1 of 3'); // the two test miners and the chain's own premine address
  // The search filters the table; the share chart above it still shows every miner.
  expect(html.match(/<td class="rank">/g)).toHaveLength(1);
});
