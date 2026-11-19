// A simulated Pearl chain with a mix of miners shaped like mainnet's, for
// developing and showing the pages without a node. Nothing here is real:
// the pools are named Pool A to Pool E and their claims are made up.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { customNetwork, networks, parsePearl } from 'pearljs';
import { SimulatedChain, testAddress } from 'pearljs/testing';
import { Store } from './db.js';
import { startIndexer } from './indexer.js';

export const demoNetwork = customNetwork(networks.regtest, { coinbaseMaturity: 10 });

// Seeded so every run builds the same chain.
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

interface Miner {
  label: string | null;
  addresses: string[];
  share: number;
}

export function demoMiners(): Miner[] {
  let n = 100;
  const addrs = (k: number): string[] => Array.from({ length: k }, () => testAddress(n++, demoNetwork));
  const pools: Miner[] = [
    { label: 'Pool A', addresses: addrs(4), share: 0.44 },
    { label: 'Pool B', addresses: addrs(1), share: 0.165 },
    { label: 'Pool C', addresses: addrs(2), share: 0.105 },
    { label: null, addresses: addrs(1), share: 0.095 },
    { label: 'Pool E', addresses: addrs(1), share: 0.08 },
  ];
  // The rest: many small miners, a few blocks each.
  const small = addrs(160).map((a) => ({ label: null, addresses: [a], share: 0.115 / 160 }));
  return [...pools, ...small];
}

export async function buildDemo(dataDir: string, blocks = 3600): Promise<{ chain: SimulatedChain; store: Store }> {
  // The demo is rebuilt from its seed every time.
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  const chain = new SimulatedChain({ network: demoNetwork, premine: 12 });
  const rand = rng(42);
  const ms = demoMiners();
  const pick = (): string => {
    let r = rand();
    for (const m of ms) {
      if ((r -= m.share) <= 0) return m.addresses[Math.floor(rand() * m.addresses.length)]!;
    }
    return ms[0]!.addresses[0]!;
  };
  let time = chain.tip.time;
  for (let i = 0; i < blocks; i++) {
    // Exponential intervals around the target, with the network slowly getting a little faster.
    const mean = demoNetwork.targetSpacing * (1.04 - (0.08 * i) / blocks);
    time += Math.max(1, Math.round(-Math.log(1 - rand()) * mean));
    chain.setTime(time);
    if (rand() < 0.3) chain.pay(testAddress(1, demoNetwork), parsePearl('1'));
    chain.mine(1, { coinbaseTo: pick() });
  }
  const store = new Store(join(dataDir, 'demo.sqlite'));
  const watch = startIndexer({ store, rpc: chain.rpc, network: demoNetwork, pollInterval: 20, now: () => chain.time });
  // One reorganisation while the indexer watches, so the stale list has something in it.
  await new Promise<void>((resolve) => {
    let seen = 0;
    const timer = setInterval(() => {
      if (store.tipHeight() === chain.height) {
        seen += 1;
        if (seen === 1) chain.reorg(1);
        if (seen === 3) {
          clearInterval(timer);
          watch.stop();
          resolve();
        }
      }
    }, 50);
  });
  await watch.done;

  const labelled = ms.filter((m) => m.label !== null);
  writeFileSync(join(dataDir, 'labels.json'), JSON.stringify({
    identities: labelled.map((m) => ({ label: m.label, scripts: m.addresses, source: 'demo data, not a real attribution' })),
  }, null, 2));
  const readAt = chain.time;
  writeFileSync(join(dataDir, 'claims.json'), JSON.stringify({
    claims: [
      { label: 'Pool A', hashrate: 43.9, networkHashrate: 91.9, readAt, source: 'demo stats site' },
      { label: 'Pool B', share: 0.17, readAt, source: 'demo pool page' },
      { label: 'Pool C', share: 0.15, readAt, source: 'demo pool page' },
    ],
  }, null, 2));
  return { chain, store };
}
