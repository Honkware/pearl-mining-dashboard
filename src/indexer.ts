// Follows the node's best chain into the store. Each event and the
// follower's cursor are written in one transaction, so a crash between
// blocks resumes exactly where the store stands.
import { watchChain, type ChainWatch, type FollowEvent, type FollowOptions, type PearlNetwork, type PearldRpc } from 'pearljs';
import { blockFacts, coinbaseSpends } from './facts.js';
import type { Store } from './db.js';

export interface IndexerOptions {
  store: Store;
  rpc: Pick<PearldRpc, 'call' | 'getChainTips' | 'getBlockHeader'>;
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
  log(`[index] start ${saved !== null ? `after ${saved.height} ${saved.hash.slice(0, 16)}` : `at ${from.height}`}`);

  return watchChain(rpc, {
    from,
    stopAtTip: opts.stopAtTip ?? false,
    ...(opts.pollInterval === undefined ? {} : { pollInterval: opts.pollInterval }),
    ...(opts.ws === undefined ? {} : { ws: opts.ws }),
    onRetry: (err, attempt) => log(`[index] retry ${attempt}: ${err.message}`),
    onEvent: async (event, cursor) => {
      if (event.type === 'connected') {
        const facts = blockFacts(event.block, event.height, event.hash, network);
        if (facts.checkFailed !== null) log(`[index] block ${event.height} ${event.hash} failed ${facts.checkFailed}`);
        store.tx(() => {
          store.connect(facts, coinbaseSpends(event.block, (o) => store.isCoinbaseOutput(o)));
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
        await noteForks(opts, now());
        log(`[index] synced at ${event.height}`);
      }
      opts.onEvent?.(event);
    },
  });
}

// Side branches the node stored but did not follow: stale blocks that never
// reached this store as connected. Only what this node saw.
async function noteForks(opts: IndexerOptions, seenAt: number): Promise<void> {
  const tips = await opts.rpc.getChainTips();
  for (const tip of tips) {
    if (tip.status === 'active') continue;
    let time: number | null = null;
    try {
      time = (await opts.rpc.getBlockHeader(tip.hash)).time;
    } catch {
      // A tip with only a header announced may be gone already; its height is still worth keeping.
    }
    if (opts.store.noteForkTip(tip.hash, tip.height, time, seenAt)) opts.log?.(`[index] fork tip ${tip.height} ${tip.hash} (${tip.status})`);
  }
}
