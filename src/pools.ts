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
import { cleanTag } from './facts.js';
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
  /** The URLs answer with HTML rather than JSON; the parser then gets text. */
  html?: boolean;
  /** The page a person can check. */
  site: string;
  /** API URLs fetched, in order; the parser gets their bodies in the same order. */
  urls: string[];
  parse(bodies: Json[]): Evidence;
}

const strip0x = (h: string): string => h.replace(/^0x/, '').toLowerCase();

// Miningcore's /api/pools/<id>: the pool's hashrate and the network's; nothing when the pool reports none.
const miningcoreClaim = (p: Json): Pick<Evidence, 'claim'> => {
  const hashrate = p.pool?.poolStats?.poolHashrate ?? 0;
  const networkHashrate = p.pool?.networkStats?.networkHashrate ?? 0;
  return hashrate > 0 && networkHashrate > 0 ? { claim: { hashrate, networkHashrate } } : {};
};

// open-ethereum-pool's /api/blocks: blocks waiting, immature and matured.
const openEthereumPoolHashes = (b: Json): string[] =>
  [...(b.candidates ?? []), ...(b.immature ?? []), ...(b.matured ?? [])].map((x: Json) => strip0x(x.hash));

// Endpoints read from each site's own network requests on 2026-11-18.
// No list found for F2Pool or minerlab (its API refused requests that day), or for
// suprnova, rplant, pooly.ca, veinpool and getablocks (no Pearl blocks in their feeds).
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
    label: '2Miners',
    site: 'https://prl.2miners.com',
    urls: ['https://prl.2miners.com/api/blocks', 'https://prl.2miners.com/api/stats'],
    parse: ([b, s]) => ({
      blockHashes: openEthereumPoolHashes(b),
      claim: { hashrate: s.hashrate, networkHashrate: Number(s.nodes[0].networkhashps) },
    }),
  },
  {
    // Solo blocks pay the miner who found them, so these addresses are 2Miners' solo users, not 2Miners.
    label: '2Miners Solo',
    site: 'https://solo-prl.2miners.com',
    urls: ['https://solo-prl.2miners.com/api/blocks'],
    parse: ([b]) => ({ blockHashes: openEthereumPoolHashes(b) }),
  },
  {
    label: 'AlphaPool',
    site: 'https://pearl.alphapool.tech',
    urls: ['https://pearl.alphapool.tech/api/blocks'],
    parse: ([b]) => ({ blockHashes: b.map((x: Json) => strip0x(x.hash)) }),
  },
  {
    label: 'HimPool',
    site: 'https://himpool.com',
    urls: ['https://himpool.com/api/pools/prl/blocks?page=0&pageSize=100', 'https://himpool.com/api/pools/prl'],
    // The same feed carries blocks of a merge-mined chain; keep Pearl's own.
    parse: ([b, p]) => ({ blockHashes: b.filter((x: Json) => x.type !== 'auxpow' && String(x.poolId).startsWith('prl')).map((x: Json) => strip0x(x.hash)), ...miningcoreClaim(p) }),
  },
  {
    label: 'Rabid Mining',
    site: 'https://pool.rabidmining.com',
    urls: ['https://pool.rabidmining.com/api/pools/pearl/blocks?page=0&pageSize=100', 'https://pool.rabidmining.com/api/pools/pearl'],
    parse: ([b, p]) => ({ blockHashes: b.map((x: Json) => strip0x(x.hash)), ...miningcoreClaim(p) }),
  },
  {
    // F2Pool lists no blocks or wallet; its homepage table gives its Pearl hashrate and the network's.
    // Its blocks are named by the /F2Pool/ tag it writes in its coinbases.
    label: 'F2Pool',
    site: 'https://www.f2pool.com',
    urls: ['https://www.f2pool.com/'],
    html: true,
    parse: ([page]) => {
      const text = String(page).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const row = text.match(/PRL\b[^$]*\$[^/]*\/\w+\s+([\d.,]+)\s*([KMGTPE])H\/s\s+([\d.,]+)\s*([KMGTPE])H\/s/);
      if (row === null) return {};
      const scale = (n: string, u: string): number => Number(n.replace(/,/g, '')) * 10 ** (3 * ('KMGTPE'.indexOf(u) + 1));
      return { claim: { hashrate: scale(row[1]!, row[2]!), networkHashrate: scale(row[3]!, row[4]!) } };
    },
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
  /** Pool hashrates it republishes, used for pools whose own site gives none. */
  claims?(bodies: Json[]): { pool: string; hashrate: number; networkHashrate: number }[];
}

// Read after the pools' own data, in this order; an address already named keeps its name.
export const TRACKERS: TrackerSource[] = [
  {
    name: 'pearlstation.io',
    urls: ['https://pearlstation.io/api/blocks', 'https://pearlstation.io/api/pools', 'https://pearlstation.io/api/network'],
    parse: ([b]) => b.recent.filter((x: Json) => x.pool && x.addr).map((x: Json) => ({ pool: x.name, address: x.addr })),
    claims: ([, pools, net]) => {
      // Its latest network hashrate, from the same site, so the share is in one unit.
      const network = net.ranges.day.at(-1)?.[1] ?? 0;
      return pools.pools.filter((p: Json) => typeof p.hashrate === 'number' && p.hashrate > 0).map((p: Json) => ({ pool: p.name, hashrate: p.hashrate, networkHashrate: network }));
    },
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

/**
 * Names still-unnamed addresses by the coinbase tag they keep writing, when the
 * tag names a known pool (as F2Pool's "/F2Pool/"). Tags are self-declared, so
 * this comes after everything else, and only over the last month of blocks.
 */
export function tagLabels(store: Store, pools: string[], taken: Set<string>, day: string): LabelEntry[] {
  const rows = store.db
    .prepare('SELECT payout_script AS script, tag FROM blocks WHERE tag IS NOT NULL AND height > (SELECT MAX(height) FROM blocks) - 13361')
    .all() as { script: string; tag: string }[];
  const seen = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (taken.has(r.script)) continue;
    const m = seen.get(r.script) ?? new Map<string, number>();
    for (const t of cleanTag(r.tag).split(' ')) if (t !== '') m.set(sameName(t), (m.get(sameName(t)) ?? 0) + 1);
    seen.set(r.script, m);
  }
  const byPool = new Map<string, string[]>();
  for (const [script, tags] of seen) {
    for (const pool of new Set(pools)) {
      const key = sameName(pool);
      if (key.length >= 2 && (tags.get(key) ?? 0) >= 2) byPool.set(pool, [...(byPool.get(pool) ?? []), script]);
    }
  }
  return [...byPool].map(([label, scripts]) => ({ label, scripts, source: `coinbase tag, read ${day}` }));
}

/**
 * Coinbase outputs can only be spent by whoever holds their key, so two
 * addresses whose coinbases are spent in one transaction have one owner.
 * Groups addresses that way and gives each group the one name it already
 * contains; a group holding two different names is left alone.
 */
export function linkBySpending(store: Store, labels: LabelEntry[], day: string): { added: LabelEntry[]; clashes: string[][] } {
  const rows = store.db
    .prepare('SELECT s.txid AS txid, p.script AS script FROM spends s JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout')
    .all() as { txid: string; script: string }[];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const byTx = new Map<string, string>();
  for (const { txid, script } of rows) {
    if (!parent.has(script)) parent.set(script, script);
    const first = byTx.get(txid);
    if (first === undefined) byTx.set(txid, script);
    else parent.set(find(script), find(first));
  }
  const nameOf = new Map<string, string>();
  for (const l of labels) for (const s of l.scripts) nameOf.set(s, l.label);
  const groups = new Map<string, string[]>();
  for (const s of parent.keys()) groups.set(find(s), [...(groups.get(find(s)) ?? []), s]);
  const added: LabelEntry[] = [];
  const clashes: string[][] = [];
  for (const members of groups.values()) {
    const names = [...new Set(members.map((m) => nameOf.get(m)).filter((n): n is string => n !== undefined))];
    if (names.length > 1) clashes.push(names.sort());
    if (names.length !== 1) continue;
    const unnamed = members.filter((m) => !nameOf.has(m));
    if (unnamed.length > 0) added.push({ label: names[0]!, scripts: unnamed, source: `coinbases spent together with ${names[0]}'s, read ${day}` });
  }
  return { added, clashes };
}

export interface PoolsRun {
  results: PoolResult[];
  labels: LabelEntry[];
  claims: Claim[];
  /** Scripts two pools both pointed to; left unlabelled. */
  conflicts: { script: string; pools: string[] }[];
  /** Groups of linked addresses that hold more than one name; none of their unnamed members is named. */
  clashes: string[][];
}

// Trackers spell pools their own way: "Lucky Pool", "skypool.org", "Jetski" for LuckyPool, Skypool, Jetski Pool.
const sameName = (a: string): string =>
  a.toLowerCase().replace(/\.(com|org|io|xyz|net|tech)$/, '').replace(/[^a-z0-9]/g, '').replace(/pool$/, '');

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
        bodies.push(pool.html === true ? await res.text() : await res.json());
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
  const trackerClaims: Claim[] = [];
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
      for (const c of t.claims?.(bodies) ?? []) {
        const label = results.find((r) => sameName(r.label) === sameName(c.pool))?.label ?? trackerLabels.find((l) => sameName(l.label) === sameName(c.pool))?.label ?? c.pool;
        if (c.networkHashrate > 0 && !trackerClaims.some((x) => x.label === label) && !results.some((r) => r.label === label && r.claim !== undefined)) {
          trackerClaims.push({ label, hashrate: c.hashrate, networkHashrate: c.networkHashrate, readAt: opts.now, source: t.name });
        }
      }
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
  labels.push(...tagLabels(opts.store, [...(opts.pools ?? POOLS).map((p) => p.label), ...trackerLabels.map((l) => l.label)], new Set(labels.flatMap((l) => l.scripts)), day));
  const linked = linkBySpending(opts.store, labels, day);
  const claims = [...results.flatMap((r) => (r.claim === undefined ? [] : [r.claim])), ...trackerClaims];
  return { results, labels: [...labels, ...linked.added], claims, conflicts, clashes: linked.clashes };
}

/** Writes pool-labels.json and pool-claims.json; the hand-edited labels.json and claims.json are left alone. */
export function writePools(dataDir: string, run: PoolsRun): void {
  writeFileSync(join(dataDir, 'pool-labels.json'), JSON.stringify({ identities: run.labels }, null, 2));
  writeFileSync(join(dataDir, 'pool-claims.json'), JSON.stringify({ claims: run.claims }, null, 2));
}
