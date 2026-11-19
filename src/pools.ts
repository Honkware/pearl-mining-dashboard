// Names pools from what they publish about themselves. Each pool's public
// API gives one kind of evidence: the hashes of blocks it says it found, its
// coinbase wallet, or the txids of its payouts (which spend its coinbases).
// The evidence is matched against the indexed chain, so a label always rests
// on blocks this node has and on a dated copy of the pool's own data.
// Pools that publish none of these stay unnamed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toOutputScript, type PearlNetwork } from 'pearljs';
import type { Store } from './db.js';
import type { Claim, LabelEntry } from './labels.js';

// Pool APIs are untyped; each parser reads the few fields it needs.
type Json = any;

export interface Evidence {
  blockHashes?: string[];
  wallet?: string;
  payoutTxids?: string[];
  claim?: { hashrate: number; networkHashrate: number };
}

export interface PoolSource {
  label: string;
  /** The page a person can check. */
  site: string;
  /** API URLs fetched, in order; the parser gets their bodies in the same order. */
  urls: string[];
  parse(bodies: Json[]): Evidence;
}

const strip0x = (h: string): string => h.replace(/^0x/, '').toLowerCase();

// Endpoints read from each site's own network requests on 2026-11-18.
// No list found for F2Pool or minerlab (its API refused requests that day).
export const POOLS: PoolSource[] = [
  {
    label: 'Kryptex',
    site: 'https://pool.kryptex.com/prl/blocks',
    urls: [...[1, 2, 3, 4, 5, 6, 7].map((p) => `https://prl-api.kryptex.network/api/v1/pool/blocks?page=${p}`), 'https://prl-api.kryptex.network/api/v1/pool/stats'],
    parse: (b) => {
      const stats = b[b.length - 1];
      return {
        blockHashes: b.slice(0, -1).flatMap((p: Json) => (p?.results ?? []).map((x: Json) => strip0x(x.hash))),
        claim: { hashrate: stats.hashrate, networkHashrate: stats.net_hashrate },
      };
    },
  },
  {
    label: 'Pearlhash',
    site: 'https://pearlhash.xyz',
    urls: ['https://pearlhash.xyz/api/pool-wallet-txs?page=1'],
    parse: ([w]) => ({ wallet: w.address }),
  },
  {
    label: 'LuckyPool',
    site: 'https://pearl.luckypool.io',
    urls: ['https://pearl.luckypool.io/api/stats?v=2'],
    parse: ([s]) => ({
      blockHashes: (s.blocks ?? []).map((x: Json) => strip0x(x.hash)),
      claim: { hashrate: s.stats.pool.hashrate, networkHashrate: s.network.hashrate },
    }),
  },
  {
    label: 'Pearl Fortune',
    site: 'https://pearlfortune.org/pearl/',
    urls: ['https://pearlfortune.org/pearl/api/v1/blocks?page=1&page_size=100', 'https://pearlfortune.org/pearl/api/v1/summary?hours=24&tz_offset_min=0'],
    parse: ([blocks, summary]) => {
      const hour = summary.data.pool_stats.hourly_stats.at(-1);
      return {
        blockHashes: blocks.data.blocks.map((x: Json) => strip0x(x.block_hash)),
        claim: { hashrate: hour.pool_hashrate, networkHashrate: hour.network_hashrate },
      };
    },
  },
  {
    label: 'Peryn',
    site: 'https://peryn.ai/live',
    urls: ['https://peryn.ai/api/live'],
    parse: ([l]) => ({
      payoutTxids: l.payments.payments.flatMap((p: Json) => p.txids),
      claim: { hashrate: l.network.pool.hashrate, networkHashrate: l.pool.networkHashrate },
    }),
  },
  {
    label: 'Jetski Pool',
    site: 'https://pearl.jetskipool.ai/blocks',
    urls: ['https://pearl.jetskipool.ai/api/stats'],
    parse: ([s]) => ({
      blockHashes: s.recent_blocks_found.map((x: Json) => strip0x(x.block_hash)),
      claim: { hashrate: s.pool_hashrate_6h, networkHashrate: s.network_hashrate },
    }),
  },
  {
    label: 'HeroMiners',
    site: 'https://pearl.herominers.com',
    urls: ['https://pearl.herominers.com/api/stats'],
    // pool.blocks alternates "hash:time:...:..." strings with their heights.
    parse: ([s]) => ({
      blockHashes: s.pool.blocks.filter((x: Json) => typeof x === 'string' && x.includes(':')).map((x: string) => strip0x(x.split(':')[0]!)),
      claim: { hashrate: s.pool.hashrate, networkHashrate: s.network.networkHashps },
    }),
  },
  {
    label: 'Skypool',
    site: 'https://pool.skypool.org/prl',
    urls: ['https://api.main.skypool.xyz/v1/prl/blocks?limit=100'],
    parse: ([b]) => ({ blockHashes: b.data.items.map((x: Json) => strip0x(x.hash)) }),
  },
];

/** A tracker that publishes which address belongs to which pool, for many pools at once. */
export interface TrackerSource {
  name: string;
  urls: string[];
  parse(bodies: Json[]): { pool: string; address: string }[];
}

// Read after the pools' own data, in this order; an address already named keeps its name.
export const TRACKERS: TrackerSource[] = [
  {
    name: 'pearlstation.io',
    urls: ['https://pearlstation.io/api/blocks'],
    parse: ([b]) => b.recent.filter((x: Json) => x.pool && x.addr).map((x: Json) => ({ pool: x.name, address: x.addr })),
  },
  {
    name: 'pearltrack.io',
    urls: ['https://pearltrack.io/api/pools'],
    parse: ([p]) => p.filter((x: Json) => x.address).map((x: Json) => ({ pool: x.name, address: x.address })),
  },
];

export interface PoolResult {
  label: string;
  scripts: Map<string, number>;
  /** Published blocks found in the index, and published blocks in all. */
  matched: number;
  published: number;
  kind: 'blocks' | 'wallet' | 'payouts';
  claim?: Claim;
  error?: string;
}

/** Payout scripts the evidence points to, each with how many blocks or payouts back it. */
export function matchEvidence(store: Store, network: PearlNetwork, e: Evidence): { scripts: Map<string, number>; matched: number; published: number; kind: PoolResult['kind'] } {
  const scripts = new Map<string, number>();
  const add = (s: string): void => {
    scripts.set(s, (scripts.get(s) ?? 0) + 1);
  };
  if (e.wallet !== undefined) {
    add(Buffer.from(toOutputScript(e.wallet, network)).toString('hex'));
    return { scripts, matched: 1, published: 1, kind: 'wallet' };
  }
  if (e.payoutTxids !== undefined) {
    const q = store.db.prepare('SELECT p.script FROM spends s JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout WHERE s.txid = ?');
    let matched = 0;
    for (const txid of e.payoutTxids) {
      const rows = q.all(txid) as { script: string }[];
      if (rows.length > 0) matched += 1;
      for (const r of rows) add(r.script);
    }
    return { scripts, matched, published: e.payoutTxids.length, kind: 'payouts' };
  }
  const hashes = e.blockHashes ?? [];
  const q = store.db.prepare('SELECT payout_script FROM blocks WHERE hash = ?');
  let matched = 0;
  for (const h of hashes) {
    const row = q.get(h) as { payout_script: string } | undefined;
    if (row === undefined) continue;
    matched += 1;
    add(row.payout_script);
  }
  return { scripts, matched, published: hashes.length, kind: 'blocks' };
}

export interface PoolsRun {
  results: PoolResult[];
  labels: LabelEntry[];
  claims: Claim[];
  /** Scripts two pools both pointed to; left unlabelled. */
  conflicts: { script: string; pools: string[] }[];
}

const sameName = (a: string): string => a.toLowerCase().replace(/[^a-z0-9]/g, '');

export async function collectPools(opts: { store: Store; network: PearlNetwork; dataDir: string; now: number; fetch?: typeof fetch; pools?: PoolSource[]; trackers?: TrackerSource[] }): Promise<PoolsRun> {
  const get = opts.fetch ?? fetch;
  const day = new Date(opts.now * 1000).toISOString().slice(0, 10);
  const dir = join(opts.dataDir, 'sources', day);
  mkdirSync(dir, { recursive: true });
  const results: PoolResult[] = [];
  for (const pool of opts.pools ?? POOLS) {
    try {
      const bodies: Json[] = [];
      for (const url of pool.urls) {
        const res = await get(url, { headers: { 'user-agent': 'pearl-mining-dashboard' } });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        bodies.push(await res.json());
      }
      writeFileSync(join(dir, `${pool.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`), JSON.stringify({ label: pool.label, urls: pool.urls, read: opts.now, bodies }));
      const e = pool.parse(bodies);
      const m = matchEvidence(opts.store, opts.network, e);
      const claim = e.claim !== undefined && e.claim.networkHashrate > 0
        ? { label: pool.label, hashrate: e.claim.hashrate, networkHashrate: e.claim.networkHashrate, readAt: opts.now, source: pool.site }
        : undefined;
      results.push({ label: pool.label, ...m, ...(claim === undefined ? {} : { claim }) });
    } catch (err) {
      results.push({ label: pool.label, scripts: new Map(), matched: 0, published: 0, kind: 'blocks', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const trackerLabels: LabelEntry[] = [];
  const named = (): Set<string> => new Set([...results.flatMap((r) => [...r.scripts.keys()]), ...trackerLabels.flatMap((l) => l.scripts)]);
  for (const t of opts.trackers ?? TRACKERS) {
    try {
      const bodies: Json[] = [];
      for (const url of t.urls) {
        const res = await get(url, { headers: { 'user-agent': 'pearl-mining-dashboard' } });
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        bodies.push(await res.json());
      }
      writeFileSync(join(dir, `${t.name.replace(/[^a-z0-9]+/g, '-')}.json`), JSON.stringify({ tracker: t.name, urls: t.urls, read: opts.now, bodies }));
      const taken = named();
      const byPool = new Map<string, string[]>();
      for (const { pool, address } of t.parse(bodies)) {
        let script: string;
        try {
          script = Buffer.from(toOutputScript(address, opts.network)).toString('hex');
        } catch {
          continue;
        }
        if (taken.has(script)) continue;
        // Use the pool's own spelling when the tracker names a pool we already know.
        const label = results.find((r) => sameName(r.label) === sameName(pool))?.label ?? pool;
        byPool.set(label, [...new Set([...(byPool.get(label) ?? []), script])]);
        taken.add(script);
      }
      for (const [label, scripts] of byPool) trackerLabels.push({ label, scripts, source: `${t.name}, read ${day}` });
    } catch (err) {
      results.push({ label: t.name, scripts: new Map(), matched: 0, published: 0, kind: 'blocks', error: err instanceof Error ? err.message : String(err) });
    }
  }

  const owners = new Map<string, string[]>();
  for (const r of results) for (const s of r.scripts.keys()) owners.set(s, [...(owners.get(s) ?? []), r.label]);
  const conflicts = [...owners].filter(([, p]) => p.length > 1).map(([script, pools]) => ({ script, pools }));
  const contested = new Set(conflicts.map((c) => c.script));
  const evidenceText = (r: PoolResult): string =>
    r.kind === 'wallet' ? 'coinbase wallet the pool publishes'
      : r.kind === 'payouts' ? `${r.matched} of ${r.published} published payouts spend these coinbases`
        : `${r.matched} of ${r.published} published block hashes`;
  const labels = results
    .filter((r) => r.scripts.size > 0)
    .map((r) => ({
      label: r.label,
      scripts: [...r.scripts.keys()].filter((s) => !contested.has(s) && s !== 'none'),
      source: `${POOLS.find((p) => p.label === r.label)?.site ?? r.label}, read ${day}, ${evidenceText(r)}`,
    }))
    .filter((l) => l.scripts.length > 0)
    .concat(trackerLabels);
  const claims = results.flatMap((r) => (r.claim === undefined ? [] : [r.claim]));
  return { results, labels, claims, conflicts };
}

/** Writes pool-labels.json and pool-claims.json; the hand-edited labels.json and claims.json are left alone. */
export function writePools(dataDir: string, run: PoolsRun): void {
  writeFileSync(join(dataDir, 'pool-labels.json'), JSON.stringify({ identities: run.labels }, null, 2));
  writeFileSync(join(dataDir, 'pool-claims.json'), JSON.stringify({ claims: run.claims }, null, 2));
}
