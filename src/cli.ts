#!/usr/bin/env node
// pearl-mining-dashboard index | serve
// Both read the node settings from the environment (see src/node.ts) and
// keep their data in DATA_DIR (./data unless given).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from './db.js';
import { startIndexer } from './indexer.js';
import { nodeFromEnv } from './node.js';

const log = (line: string): void => console.log(`${new Date().toISOString()} ${line}`);

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const dataDir = process.env.DATA_DIR ?? 'data';
  mkdirSync(dataDir, { recursive: true });
  if (cmd === 'demo') {
    const { buildDemo, demoNetwork } = await import('./demo.js');
    const { serve } = await import('./server.js');
    const dir = join(dataDir, 'demo');
    const { chain, store } = await buildDemo(dir, Number(process.env.DEMO_BLOCKS ?? 3600));
    // The demo chain's clock stands in for now, so ages read as they would on a live node.
    await serve({ store, network: demoNetwork, dataDir: dir, port: Number(process.env.PORT ?? 8080), host: '127.0.0.1', now: () => chain.time + 60, log });
    return;
  }
  if (cmd === 'proof-message') {
    const { proofMessage } = await import('./labels.js');
    const pool = process.argv.slice(3).join(' ');
    if (pool === '') throw new Error('usage: cli.js proof-message <pool name>');
    console.log(proofMessage(pool));
    return;
  }
  if (cmd === 'pools') {
    const { networks } = await import('pearljs');
    const { collectPools, writePools } = await import('./pools.js');
    const network = networks[(process.env.PEARL_NETWORK ?? 'mainnet') as keyof typeof networks];
    const store = new Store(join(dataDir, `${network.name}.sqlite`));
    const run = await collectPools({ store, network, dataDir, now: Math.floor(Date.now() / 1000) });
    for (const r of run.results) {
      log(`[pools] ${r.label}: ${r.error ?? `${r.scripts.size} script(s), ${r.matched} of ${r.published} ${r.kind} matched${r.claim ? `, claims ${(100 * (r.claim.hashrate! / r.claim.networkHashrate!)).toFixed(1)}%` : ''}`}`);
    }
    for (const c of run.conflicts) log(`[pools] not labelled, claimed by ${c.pools.join(' and ')}: ${c.script}`);
    for (const c of run.clashes) log(`[pools] linked addresses span ${c.join(' and ')}; their unnamed ones stay unnamed`);
    const linked = run.labels.filter((l) => l.source.startsWith('coinbases spent together'));
    log(`[pools] ${linked.reduce((n, l) => n + l.scripts.length, 0)} more addresses named by spending`);
    writePools(dataDir, run);
    store.close();
    return;
  }
  const { client, ws, network } = nodeFromEnv();
  const store = new Store(join(dataDir, `${network.name}.sqlite`));

  if (cmd === 'index') {
    const watch = startIndexer({
      store,
      rpc: client,
      ws,
      network,
      startHeight: Number(process.env.START_HEIGHT ?? 0),
      stopAtTip: process.env.STOP_AT_TIP === '1',
      log,
    });
    const stop = (): void => watch.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    try {
      await watch.done;
    } finally {
      // An open websocket would keep a failed indexer's process alive, looking healthy.
      await ws.close();
      store.close();
    }
    log('[index] stopped');
    return;
  }
  if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    void ws.close();
    await serve({ store, network, dataDir, port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '127.0.0.1', nodeHeight: () => client.getBlockCount(), log });
    return;
  }
  console.error('usage: cli.js index | serve | pools | proof-message | demo');
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
