// The static export of a small simulated chain.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { customNetwork, networks } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import { Store } from '../src/db.js';
import { exportSite, staticPath } from '../src/export.js';
import { startIndexer } from '../src/indexer.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
let dir: string;
let out: string;
let store: Store;
let pages: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pmd-exp-'));
  out = join(dir, 'site');
  const chain = new SimulatedChain({ network: net, premine: 3 });
  for (let i = 0; i < 60; i++) chain.mine(1, { coinbaseTo: testAddress(i % 3 === 0 ? 20 : 21, net) });
  store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;
  writeFileSync(join(dir, 'labels.json'), JSON.stringify({ identities: [{ label: 'Big pool', scripts: [testAddress(21, net)], source: 'test' }] }));
  pages = await exportSite({ store, network: net, dataDir: dir, outDir: out, base: '/pmd' });
});

afterAll(() => {
  store?.close();
  rmSync(dir, { recursive: true, force: true });
});

const files = (d: string): string[] => readdirSync(d, { recursive: true, encoding: 'utf8' });

test('query strings become folders and odd characters are written out', () => {
  expect(staticPath('/')).toBe('/');
  expect(staticPath('/miners?window=day&page=2')).toBe('/miners/page/2/window/day/');
  expect(staticPath('/miner/label%3ABig%20pool?window=week')).toBe('/miner/label:Big_20pool/window/week/');
  expect(staticPath('/static/app.css?v=abc')).toBe('/static/app.css');
});

test('every internal link in the export points at a file it wrote', () => {
  expect(pages).toBeGreaterThan(5);
  const htmlFiles = files(out).filter((f) => f.endsWith('.html') && f !== '404.html');
  const missing: string[] = [];
  for (const f of htmlFiles) {
    const html = readFileSync(join(out, f), 'utf8');
    for (const [, link] of html.matchAll(/href="([^"]*)"/g)) {
      if (!link!.startsWith('/')) continue;
      expect(link!.startsWith('/pmd/')).toBe(true);
      const path = link!.slice(4);
      if (!existsSync(join(out, path.endsWith('/') ? `${path}index.html` : path))) missing.push(`${f} -> ${link}`);
    }
  }
  expect(missing).toEqual([]);
});

test('the export has the labelled pool, no search form, and the tip for refreshing', () => {
  const miners = readFileSync(join(out, 'miners/index.html'), 'utf8');
  expect(miners).toContain('Big pool');
  expect(miners).not.toContain('<form');
  const overview = readFileSync(join(out, 'index.html'), 'utf8');
  expect(overview).toContain("fetch('/pmd/api/tip.json'");
  expect(JSON.parse(readFileSync(join(out, 'api/tip.json'), 'utf8')).height).toBe(63);
  expect(existsSync(join(out, 'fonts/next-400.woff2'))).toBe(true);
});
