// Follows the node's best chain into the store. Each event and the
// follower's cursor are written in one transaction, so a crash between
// blocks resumes exactly where the store stands.
import { watchChain, type ChainWatch, type FollowEvent, type FollowOptions, type MempoolEntry, type PearlNetwork, type PearldRpc } from 'pearljs';
import { blockFacts, coinbaseSpends } from './facts.js';
import type { Store } from './db.js';

export interface IndexerOptions {
  store: Store;
  rpc: Pick<PearldRpc, 'call' | 'getChainTips' | 'getBlockHeader' | 'getRawMempoolVerbose'>;
  /** Snapshot the mempool while at the tip, to record what each new block left waiting. */
  watchMempool?: boolean;
  network: PearlNetwork;
  /** Height to start from on an empty store. 0 unless given. */
  startHeight?: number;
  stopAtTip?: boolean;
  pollInterval?: number;
  /** pearld's block notifications, so a new block is indexed the moment it is announced. */
  ws?: FollowOptions['ws'];
  /** Clock for stale records, Unix seconds. */
  now?: () => number;
  onEvent?: (event: FollowEvent) => void;
  log?: (line: string) => void;
}

export function startIndexer(opts: IndexerOptions): ChainWatch {
  const { store, rpc, network } = opts;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const log = opts.log ?? (() => {});
  const saved = store.cursor();
  const savedNetwork = store.getMeta('network');
  if (savedNetwork !== null && savedNetwork !== network.name) throw new Error(`store holds ${savedNetwork} blocks, not ${network.name}`);
  if (savedNetwork === null) store.setMeta('network', network.name);
  const from = saved !== null ? { cursor: saved } : { height: opts.startHeight ?? 0 };
  let forksCheckedAt = 0;
  // Mempool snapshots, taken only once at the tip: a block found during catch-up
  // says nothing about the mempool its miner saw.
  let live = false;
  let snapshot: { at: number; entries: Record<string, MempoolEntry> } | null = null;
  const takeSnapshot = async (): Promise<void> => {
    try {
      snapshot = { at: now(), entries: await rpc.getRawMempoolVerbose() };
    } catch (err) {
      log(`[index] mempool snapshot skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const timer = opts.watchMempool === true ? setInterval(() => void (live ? takeSnapshot() : undefined), 15_000) : null;
  timer?.unref();
  log(`[index] start ${saved !== null ? `after ${saved.height} ${saved.hash.slice(0, 16)}` : `at ${from.height}`}`);

  const watch = watchChain(rpc, {
    from,
    stopAtTip: opts.stopAtTip ?? false,
    ...(opts.pollInterval === undefined ? {} : { pollInterval: opts.pollInterval }),
    ...(opts.ws === undefined ? {} : { ws: opts.ws }),
    onRetry: (err, attempt) => log(`[index] retry ${attempt}: ${err.message}`),
    onEvent: async (event, cursor) => {
      if (event.type === 'connected') {
        const facts = blockFacts(event.block, event.height, event.hash, network);
        if (facts.checkFailed !== null) log(`[index] block ${event.height} ${event.hash} failed ${facts.checkFailed}`);
        const waiting = live && snapshot !== null && now() - snapshot.at <= 60 ? leftWaiting(event.block, snapshot.entries, now()) : null;
        store.tx(() => {
          store.connect(facts, coinbaseSpends(event.block, (o) => store.isCoinbaseOutput(o)));
          if (waiting !== null) store.setMempool(event.height, waiting);
          store.setCursor(cursor);
        });
        if (event.height % 1000 === 0) log(`[index] ${event.height}`);
      } else if (event.type === 'disconnected') {
        store.tx(() => {
          store.disconnect(event.height, event.hash, now());
          store.setCursor(cursor);
        });
        log(`[index] disconnected ${event.height} ${event.hash}`);
      } else {
        // Side branches are a nice-to-have: checked at most once a minute (catching
        // up sends a synced event per block), and a slow or failed reply is skipped,
        // never allowed to stop the indexer.
        if (now() - forksCheckedAt >= 60) {
          forksCheckedAt = now();
          try {
            await noteForks(opts, now());
          } catch (err) {
            log(`[index] getchaintips skipped: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        log(`[index] synced at ${event.height}`);
        if (opts.watchMempool === true && !live) {
          live = true;
          await takeSnapshot();
        }
      }
      opts.onEvent?.(event);
    },
  });
  void watch.done.finally(() => {
    if (timer !== null) clearInterval(timer);
  }).catch(() => {});
  return watch;
}

/**
 * Transactions that had waited in the mempool at least 30 s when a block
 * arrived and are not in it. The margin leaves out what reached this node
 * after the miner had most likely built its block.
 */
export function leftWaiting(block: { transactions: { getId(): string }[] }, entries: Record<string, MempoolEntry>, arrivedAt: number): { waiting: number; fees: bigint; vsize: number } {
  const included = new Set(block.transactions.map((t) => t.getId()));
  let waiting = 0;
  let fees = 0n;
  let vsize = 0;
  for (const [txid, e] of Object.entries(entries)) {
    if (included.has(txid) || e.time > arrivedAt - 30) continue;
    waiting += 1;
    fees += e.fee;
    vsize += e.vsize;
  }
  return { waiting, fees, vsize };
}

// Side branches the node stored but did not follow: stale blocks that never
// reached this store as connected. Only what this node saw.
async function noteForks(opts: IndexerOptions, seenAt: number): Promise<void> {
  const tips = await opts.rpc.getChainTips();
  for (const tip of tips) {
    // Old tips stay listed for good; asking about each again on every check
    // would take minutes on a rate-limited node.
    if (tip.status === 'active' || opts.store.hasStale(tip.hash)) continue;
    let time: number | null = null;
    try {
      time = (await opts.rpc.getBlockHeader(tip.hash)).time;
    } catch {
      // A tip with only a header announced may be gone already; its height is still worth keeping.
    }
    if (opts.store.noteForkTip(tip.hash, tip.height, time, seenAt)) opts.log?.(`[index] fork tip ${tip.height} ${tip.hash} (${tip.status})`);
  }
}
