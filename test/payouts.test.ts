// Following coinbase rewards into the transactions that spend them, the
// mempool a block left behind, and the address page.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { customNetwork, networks, payFromAccount, toOutputScript, type MempoolEntry } from 'pearljs';
import { SimulatedChain, testAccount, testAddress } from 'pearljs/testing';
import { payoutAudit, receivedFromPools, type Context } from '../src/analysis.js';
import { Store } from '../src/db.js';
import { leftWaiting, startIndexer } from '../src/indexer.js';
import { emptyLabels } from '../src/labels.js';
import { addressPage } from '../src/views.js';

const net = customNetwork(networks.regtest, { coinbaseMaturity: 2 });
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const hex = (a: string): string => Buffer.from(toOutputScript(a, net)).toString('hex');

test('a pool whose coinbase was paid out to two miners shows it spent, with two payees, and each miner sees the payment', async () => {
  const chain = new SimulatedChain({ network: net, premine: 3 });
  const account = testAccount(0, net);
  const pool = account.deriveAddress(0);
  const [mined] = chain.mine(1, { coinbaseTo: pool });
  const [second] = chain.mine(1, { coinbaseTo: pool });
  chain.mine(3);
  const cb = chain.block(mined!.hash)!.txs[0]!;
  const value = cb.outs[0]!.value;
  const pay = payFromAccount(account, {
    network: net,
    utxos: [{ txid: cb.getId(), vout: 0, index: 0, value, script: toOutputScript(pool, net), confirmations: 5, coinbase: true }],
    recipients: [{ address: testAddress(40, net), amount: value / 2n }, { address: testAddress(41, net), amount: value / 4n }],
    changeAddress: pool,
    feeRate: 2000n,
    coinbaseMaturity: net.coinbaseMaturity,
  });
  chain.accept(pay.transaction);
  chain.mine(1);
  const dir = mkdtempSync(join(tmpdir(), 'pmd-pay-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'x.sqlite'));
  await startIndexer({ store, rpc: chain.rpc, network: net, stopAtTip: true }).done;
  const ctx: Context = { store, network: net, labels: emptyLabels(), claims: [] };

  const audit = payoutAudit(ctx, `script:${hex(pool)}`)!;
  // The subsidy falls a little every block, so the two coinbases differ.
  expect(audit.earned).toBe(value + chain.block(second!.hash)!.txs[0]!.outs[0]!.value);
  expect(audit.spent).toBe(value);
  expect(audit.txs).toBe(1);
  // Two miners; the change back to the pool's own address does not count.
  expect(audit.payees).toBe(2);
  expect(audit.sentOut).toBe(value / 2n + value / 4n);

  const got = receivedFromPools(ctx, hex(testAddress(40, net)));
  expect(got.map((r) => [r.value, r.from])).toEqual([[value / 2n, [`script:${hex(pool)}`]]]);
  const html = addressPage({ ...ctx, now: chain.time }, testAddress(40, net))!;
  expect(html).toContain('Payments from pools');
  expect(addressPage({ ...ctx, now: chain.time }, 'not an address')).toBeNull();
  store.close();
});

test('a block leaves waiting only what is not in it and had waited at least 30 s', () => {
  const entry = (time: number, fee: bigint): MempoolEntry => ({ size: 200, vsize: 150, fee, time, height: 0, depends: [] });
  const block = { transactions: [{ getId: () => 'coinbase' }, { getId: () => 'mined' }] };
  const left = leftWaiting(block, { mined: entry(0, 5n), old: entry(100, 7n), late: entry(990, 11n) }, 1000);
  expect(left).toEqual({ waiting: 1, fees: 7n, vsize: 150 });
});
