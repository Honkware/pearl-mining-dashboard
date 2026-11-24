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

  if (cmd === 'backfill') {
    // Stores made before payout outputs, or payout transactions' other inputs, were recorded:
    // re-read the blocks that hold coinbase spends missing either.
    const { parseBlock } = await import('pearljs');
    const { coinbaseSpends } = await import('./facts.js');
    const { INPUTS_COMPLETE } = await import('./db.js');
    const todo = store.db
      .prepare(
        `SELECT DISTINCT s.height AS height, b.hash AS hash FROM spends s JOIN blocks b ON b.height = s.height
         WHERE NOT EXISTS (SELECT 1 FROM spend_outputs o WHERE o.txid = s.txid)
            OR (s.inputs > (SELECT COUNT(*) FROM spends c WHERE c.txid = s.txid) AND NOT EXISTS (SELECT 1 FROM spend_inputs i WHERE i.txid = s.txid))
         ORDER BY s.height`,
      )
      .all() as { height: number; hash: string }[];
    log(`[backfill] ${todo.length} blocks to re-read`);
    for (let i = 0; i < todo.length; i++) {
      const { height, hash } = todo[i]!;
      // pearld can stall for a while when it flushes its UTXO cache; wait and ask again.
      let raw: Uint8Array | null = null;
      for (let attempt = 1; raw === null; attempt++) {
        try {
          raw = await client.getRawBlock(hash);
        } catch (err) {
          if (attempt >= 5) throw err;
          log(`[backfill] retry ${attempt} at ${height}: ${err instanceof Error ? err.message : String(err)}`);
          await new Promise((r) => setTimeout(r, 5000 * attempt));
        }
      }
      const block = parseBlock(raw);
      store.tx(() => {
        const spends = coinbaseSpends(block, (o) => store.isCoinbaseOutput(o));
        store.addSpendOutputs(height, spends);
        store.addSpendInputs(height, spends);
      });
      if ((i + 1) % 1000 === 0) log(`[backfill] ${i + 1} of ${todo.length}`);
    }
    store.setMeta(INPUTS_COMPLETE, '1');
    await ws?.close();
    store.close();
    log('[backfill] done');
    return;
  }
  if (cmd === 'index') {
    // START_BLOCKS starts an empty store that many blocks below the tip instead of at START_HEIGHT.
    let startHeight = Number(process.env.START_HEIGHT ?? 0);
    if (process.env.START_BLOCKS !== undefined && store.cursor() === null) {
      startHeight = Math.max(0, (await client.getBlockCount()) - Number(process.env.START_BLOCKS));
    }
    const watch = startIndexer({
      store,
      rpc: client,
      ...(ws === null ? {} : { ws }),
      watchMempool: true,
      network,
      startHeight,
      stopAtTip: process.env.STOP_AT_TIP === '1',
      log,
    });
    const stop = (): void => watch.stop();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    // INDEX_MINUTES stops a run after that long, for jobs that index in turns.
    const minutes = Number(process.env.INDEX_MINUTES ?? 0);
    if (minutes > 0) setTimeout(stop, minutes * 60_000).unref();
    try {
      await watch.done;
    } finally {
      // An open websocket would keep a failed indexer's process alive, looking healthy.
      await ws?.close();
      store.close();
    }
    log('[index] stopped');
    return;
  }
  if (cmd === 'serve') {
    const { serve } = await import('./server.js');
    void ws?.close();
    await serve({ store, network, dataDir, port: Number(process.env.PORT ?? 8080), host: process.env.HOST ?? '127.0.0.1', nodeHeight: () => client.getBlockCount(), refreshPools: process.env.REFRESH_POOLS !== '0', log });
    return;
  }
  console.error('usage: cli.js index | serve | pools | backfill | proof-message | demo');
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
