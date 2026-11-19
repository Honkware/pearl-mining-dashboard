// The indexer against pearljs's simulated chain: several miners, reorgs
// while running and while stopped, and coinbase outputs spent together.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { customNetwork, networks, payFromAccount, toOutputScript } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';
import { Store } from '../src/db.js';
import { startIndexer } from '../src/indexer.js';
import { links, miners, network as networkStats, recentBlocks, stale, type Context } from '../src/analysis.js';
import { emptyLabels, parseClaims, parseLabels } from '../src/labels.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function freshStore(): { path: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), 'pmd-'));
  dirs.push(dir);
  const path = join(dir, 'index.sqlite');
  return { path, store: new Store(path) };
}

const scriptHex = (address: string): string => Buffer.from(toOutputScript(address, net)).toString('hex');

function storedHashes(store: Store): string[] {
  return (store.db.prepare('SELECT hash FROM blocks ORDER BY height').all() as { hash: string }[]).map((r) => r.hash);
}

async function indexToTip(chain: SimulatedChain, store: Store): Promise<void> {
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true, now: () => chain.time }).done;
}

// Three miners in a 5:3:2 pattern, blocks 30 to 400 seconds apart.
function mineMix(chain: SimulatedChain, rounds: number): void {
  const pattern = [0, 1, 0, 2, 0, 1, 0, 2, 1, 0];
  for (let r = 0; r < rounds; r++) {
    for (const who of pattern) {
      chain.advanceTime(30 + ((r * 37 + who * 53) % 370));
      chain.mine(1, { coinbaseTo: testAddress(who + 10, net) });
    }
  }
}

describe('indexer', () => {
  test('stores every block with the script that was paid, and shares follow the block counts', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    mineMix(chain, 10);
    const { store } = freshStore();
    await indexToTip(chain, store);
    expect(storedHashes(store)).toEqual(chain.blocks.map((b) => b.hash));

    const ctx: Context = { store, network: net, labels: emptyLabels(), claims: [] };
    const rows = miners(ctx, 'all');
    const top = rows[0]!;
    expect(top.name).toBe(testAddress(10, net));
    expect(top.blocks).toBe(50);
    expect(top.shareInterval.lo).toBeLessThan(top.share);
    expect(top.shareInterval.hi).toBeGreaterThan(top.share);
    expect(rows.find((r) => r.name === testAddress(12, net))!.blocks).toBe(20);

    const n = networkStats(ctx, 'all')!;
    expect(n.blocks).toBe(chain.height);
    expect(n.emptyBlocks).toBe(chain.height);
    expect(n.rateInterval.lo).toBeLessThan(n.rate);
    store.close();
  });

  test('a reorg while running leaves the store equal to the chain and records the blocks that left', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    mineMix(chain, 2);
    const { store } = freshStore();
    let syncs = 0;
    const watch = startIndexer({
      store, rpc: chain.rpc, network: net, pollInterval: 5, now: () => chain.time,
      onEvent: (event) => {
        if (event.type !== 'synced') return;
        syncs += 1;
        if (syncs === 1) chain.reorg(2);
        else watch.stop();
      },
    });
    await watch.done;
    expect(storedHashes(store)).toEqual(chain.blocks.map((b) => b.hash));
    const gone = stale({ store, network: net, labels: emptyLabels(), claims: [] }).filter((s) => s.source === 'reorg');
    expect(gone.map((s) => s.height).sort()).toEqual([chain.height - 2, chain.height - 1]);
    store.close();
  });

  test('a restart after a reorg the indexer missed unwinds from the stored cursor', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    mineMix(chain, 2);
    const first = freshStore();
    await indexToTip(chain, first.store);
    first.store.close();

    chain.reorg(3);
    chain.mine(1);
    chain.mine(1, { coinbaseTo: testAddress(11, net) });

    const again = new Store(first.path);
    await indexToTip(chain, again);
    expect(storedHashes(again)).toEqual(chain.blocks.map((b) => b.hash));
    const ctx: Context = { store: again, network: net, labels: emptyLabels(), claims: [] };
    expect(stale(ctx).filter((s) => s.source === 'reorg')).toHaveLength(3);
    expect(recentBlocks(ctx, 1)[0]!.name).toBe(testAddress(11, net));
    again.close();
  });

  test('a store refuses to follow another network', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    const { store } = freshStore();
    store.setMeta('network', 'mainnet');
    expect(() => startIndexer({ store, rpc: chain.rpc, network: net })).toThrow(/mainnet/);
    store.close();
  });

  test('coinbase outputs of two scripts spent in one transaction link them', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    const account = testAccount(0, net);
    const a = account.deriveAddress(0);
    const b = account.deriveAddress(1);
    const [blockA] = chain.mine(1, { coinbaseTo: a });
    const [blockB] = chain.mine(1, { coinbaseTo: b });
    chain.mine(3);
    const coinA = chain.block(blockA!.hash)!.txs[0]!;
    const coinB = chain.block(blockB!.hash)!.txs[0]!;
    const utxo = (tx: typeof coinA, address: string, index: number) => ({
      txid: tx.getId(), vout: 0, index, value: tx.outs[0]!.value, script: toOutputScript(address, net), address, confirmations: 3, coinbase: true,
    });
    const pay = payFromAccount(account, {
      network: net,
      utxos: [utxo(coinA, a, 0), utxo(coinB, b, 1)],
      recipients: [{ address: testAddress(5, net), amount: 'max' }],
      feeRate: 2000n,
      coinbaseMaturity: net.coinbaseMaturity,
    });
    chain.accept(pay.transaction);
    chain.mine(1);

    const { store } = freshStore();
    await indexToTip(chain, store);
    const ctx: Context = { store, network: net, labels: emptyLabels(), claims: [] };
    const found = links(ctx, `script:${scriptHex(a)}`);
    expect(found.coSpent).toHaveLength(1);
    expect(found.coSpent[0]!.txid).toBe(pay.txid);
    expect(found.coSpent[0]!.with).toEqual([`script:${scriptHex(b)}`]);

    // Grouped by hand, the two scripts are one identity and the link is internal.
    const labels = parseLabels(JSON.stringify({ identities: [{ label: 'Test pool', scripts: [a, scriptHex(b)], source: 'test' }] }), net);
    const grouped = miners({ ...ctx, labels }, 'all').find((r) => r.name === 'Test pool')!;
    expect(grouped.blocks).toBe(2);
    expect(grouped.scripts).toBe(2);
    store.close();
  });

  test('a claim of a larger share than the chain shows gets a small probability', async () => {
    const chain = new SimulatedChain({ network: net, premine: 3 });
    mineMix(chain, 20);
    const { store } = freshStore();
    await indexToTip(chain, store);
    const labels = parseLabels(JSON.stringify({ identities: [{ label: 'Small pool', scripts: [testAddress(12, net)], source: 'test' }] }), net);
    const claims = parseClaims(JSON.stringify({ claims: [{ label: 'Small pool', share: 0.4, readAt: chain.time, source: 'test' }] }));
    const row = miners({ store, network: net, labels, claims }, 'all').find((r) => r.name === 'Small pool')!;
    expect(row.blocks).toBe(40);
    expect(row.claim!.expected).toBeCloseTo(0.4 * chain.height, 6);
    expect(row.claim!.atMost).toBeLessThan(1e-6);
    expect(row.claim!.luck).toBeLessThan(0.6);
    store.close();
  });
});
