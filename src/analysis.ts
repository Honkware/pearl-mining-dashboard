// Window statistics over the store. A window is the last N blocks, not a
// span of clock time: the block count is then fixed, which is what the
// binomial intervals condition on, and a node that is behind or a test chain
// with its own clock gives the same answers as a current one. The sizes are
// a day, a week and 30 days of 194-second blocks.
import type { PearlNetwork } from 'pearljs';
import { INPUTS_COMPLETE, type Store } from './db.js';
import { claimedShare, identityName, identityOf, type Claim, type Fee, type Labels } from './labels.js';
import { cleanTag, DEFAULT_TAG } from './facts.js';
import { binomialAtLeast, binomialAtMost, countInterval, shareInterval, type Interval } from './stats.js';

export const WINDOWS = { day: 445, week: 3118, month: 13_361, all: Infinity } as const;
export type WindowName = keyof typeof WINDOWS;

interface BlockRow {
  height: number;
  hash: string;
  time: number;
  bits: number;
  difficulty: number;
  work: number;
  cert_version: number | null;
  cert_kind: string | null;
  tx_count: number;
  vsize: number;
  /** Grain. One block's reward is far below 2^53, so a number holds it exactly; sums are taken as bigint. */
  reward: number;
  subsidy: number;
  tag: string | null;
  payout_script: string;
  payout_count: number;
}

export interface Context {
  store: Store;
  network: PearlNetwork;
  labels: Labels;
  claims: Claim[];
  fees?: Fee[];
}

export interface Network {
  window: WindowName;
  blocks: number;
  fromHeight: number;
  toHeight: number;
  /** Seconds from the block before the window to the last block in it. */
  span: number;
  /** Work per second, pearld's getnetworkhashps over the same blocks; interval from the block count. */
  rate: number;
  rateInterval: Interval;
  meanInterval: number;
  /** span over blocks times the 194 s target. Above 1: blocks came slower than the target. */
  effort: number;
  difficulty: number;
  difficultyChange: number;
  emptyBlocks: number;
  reward: bigint;
  feesClaimed: bigint;
  identities: number;
}

export interface MinerRow {
  id: string;
  name: string;
  labelled: boolean;
  scripts: number;
  blocks: number;
  share: number;
  shareInterval: Interval;
  rate: number;
  rateInterval: Interval;
  empty: number;
  lastTime: number;
  lastHeight: number;
  tags: string[];
  claim: ClaimTest | null;
  /** Unnamed, but pays its coinbases out to many addresses at once, as a pool does. */
  paysOut: boolean;
}

export interface ClaimTest {
  claim: Claim;
  share: number;
  expected: number;
  /** Blocks found over blocks expected at the claimed share. */
  luck: number;
  atMost: number;
  atLeast: number;
}

// Rows come back as plain numbers: copying each into a new object was most
// of a page's time on a long window.
function rows(ctx: Context, sql: string, ...params: (number | string)[]): BlockRow[] {
  return ctx.store.db.prepare(sql).all(...params) as unknown as BlockRow[];
}

const COLUMNS = 'height, hash, time, bits, difficulty, work, cert_version, cert_kind, tx_count, vsize, reward, subsidy, tag, payout_script, payout_count';

/**
 * The tags a miner writes again and again, most used first. Each block's tag
 * often carries a few stray bytes of its extra nonce, so a variant seen in
 * fewer than 2 blocks, or under 5% of them, is noise.
 */
function commonTags(raw: (string | null)[]): string[] {
  const counts = new Map<string, number>();
  for (const r of raw) {
    if (r === null) continue;
    for (const t of cleanTag(r).split(' ')) if (t !== '' && t !== DEFAULT_TAG) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const floor = Math.max(2, raw.length * 0.05);
  return [...counts].filter(([, n]) => n >= floor || raw.length === 1).sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

export function tipTime(ctx: Context): number | null {
  const row = ctx.store.db.prepare('SELECT time FROM blocks ORDER BY height DESC LIMIT 1').get() as { time: number } | undefined;
  return row?.time ?? null;
}

/** The window's blocks, plus the one before it, whose timestamp starts the span. */
// A page asks for the same window several times (figures, miners, chart, block
// times); it is read from SQLite once per window and tip, and kept for the
// next request until a new block arrives.
const windowCache = new WeakMap<Store, Map<string, { before: BlockRow | null; blocks: BlockRow[] }>>();

function windowBlocks(ctx: Context, window: WindowName): { before: BlockRow | null; blocks: BlockRow[] } {
  const tip = ctx.store.db.prepare('SELECT hash FROM blocks ORDER BY height DESC LIMIT 1').get() as { hash: string } | undefined;
  const key = `${tip?.hash ?? ''}|${window}`;
  let byKey = windowCache.get(ctx.store);
  if (byKey === undefined) windowCache.set(ctx.store, (byKey = new Map()));
  const hit = byKey.get(key);
  if (hit !== undefined) return hit;
  for (const k of byKey.keys()) if (!k.startsWith(`${tip?.hash ?? ''}|`)) byKey.delete(k);
  const loaded = loadWindow(ctx, window);
  byKey.set(key, loaded);
  return loaded;
}

function loadWindow(ctx: Context, window: WindowName): { before: BlockRow | null; blocks: BlockRow[] } {
  const size = WINDOWS[window];
  const all = size === Infinity
    ? rows(ctx, `SELECT ${COLUMNS} FROM blocks ORDER BY height`)
    : rows(ctx, `SELECT ${COLUMNS} FROM blocks ORDER BY height DESC LIMIT ?`, size + 1).reverse();
  const [before, ...blocks] = all;
  return { before: before ?? null, blocks };
}

export function network(ctx: Context, window: WindowName): Network | null {
  const { before, blocks } = windowBlocks(ctx, window);
  if (blocks.length === 0 || before === null) return null;
  const last = blocks[blocks.length - 1]!;
  const span = Math.max(1, last.time - before.time);
  const work = blocks.reduce((s, b) => s + b.work, 0);
  const n = blocks.length;
  const rate = work / span;
  const ci = countInterval(n);
  const ids = new Set(blocks.map((b) => identityOf(b.payout_script, ctx.labels)));
  return {
    window,
    blocks: n,
    fromHeight: blocks[0]!.height,
    toHeight: last.height,
    span,
    rate,
    rateInterval: { lo: (rate * ci.lo) / n, hi: (rate * ci.hi) / n },
    meanInterval: span / n,
    effort: span / (n * ctx.network.targetSpacing),
    difficulty: last.difficulty,
    difficultyChange: last.difficulty / before.difficulty - 1,
    emptyBlocks: blocks.filter((b) => b.tx_count === 1).length,
    reward: blocks.reduce((s, b) => s + BigInt(b.reward), 0n),
    feesClaimed: blocks.reduce((s, b) => s + (b.reward > b.subsidy ? BigInt(b.reward - b.subsidy) : 0n), 0n),
    identities: ids.size,
  };
}

function claimFor(ctx: Context, name: string, tip: number): Claim | null {
  // The most recent claim read before the tip; one read after the data would test the future.
  const mine = ctx.claims.filter((c) => c.label === name && c.readAt <= tip + 86_400).sort((a, b) => b.readAt - a.readAt);
  return mine[0] ?? null;
}

export function miners(ctx: Context, window: WindowName): MinerRow[] {
  const { before, blocks } = windowBlocks(ctx, window);
  if (blocks.length === 0 || before === null) return [];
  const n = blocks.length;
  const span = Math.max(1, blocks[blocks.length - 1]!.time - before.time);
  const meanWork = blocks.reduce((s, b) => s + b.work, 0) / n;
  const tip = blocks[blocks.length - 1]!.time;
  // Payout scripts whose coinbases were spent into ten or more outputs.
  const payers = new Set(
    // CROSS JOIN keeps SQLite starting from the few wide spends instead of every coinbase output.
    (ctx.store.db.prepare('SELECT DISTINCT p.script AS script FROM spends s CROSS JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout WHERE s.outputs >= 10').all() as { script: string }[]).map((r) => r.script),
  );
  const groups = new Map<string, { blocks: BlockRow[]; scripts: Set<string> }>();
  for (const b of blocks) {
    const id = identityOf(b.payout_script, ctx.labels);
    const g = groups.get(id) ?? { blocks: [], scripts: new Set() };
    g.blocks.push(b);
    g.scripts.add(b.payout_script);
    groups.set(id, g);
  }
  const out: MinerRow[] = [];
  for (const [id, g] of groups) {
    const k = g.blocks.length;
    const ci = countInterval(k);
    const name = identityName(id, ctx.network);
    const labelled = id.startsWith('label:');
    // A claim describes the pool now; it is only held against the last day or week of blocks.
    const claim = labelled && (window === 'day' || window === 'week') ? claimFor(ctx, name, tip) : null;
    const last = g.blocks[g.blocks.length - 1]!;
    let test: ClaimTest | null = null;
    if (claim !== null) {
      const share = claimedShare(claim);
      test = { claim, share, expected: n * share, luck: k / (n * share), atMost: binomialAtMost(k, n, share), atLeast: binomialAtLeast(k, n, share) };
    }
    out.push({
      id,
      name,
      labelled,
      scripts: g.scripts.size,
      blocks: k,
      share: k / n,
      shareInterval: shareInterval(k, n),
      rate: (k * meanWork) / span,
      rateInterval: { lo: (ci.lo * meanWork) / span, hi: (ci.hi * meanWork) / span },
      empty: g.blocks.filter((b) => b.tx_count === 1).length,
      lastTime: last.time,
      lastHeight: last.height,
      tags: commonTags(g.blocks.map((b) => b.tag)),
      paysOut: !labelled && [...g.scripts].some((s) => payers.has(s)),
      claim: test,
    });
  }
  return out.sort((a, b) => b.blocks - a.blocks || b.lastHeight - a.lastHeight);
}

export interface RecentBlock {
  height: number;
  hash: string;
  time: number;
  interval: number | null;
  id: string;
  name: string;
  reward: bigint;
  txCount: number;
  vsize: number;
  certVersion: number | null;
  certKind: string | null;
  tag: string | null;
  payoutCount: number;
  /** Transactions left waiting in the mempool when the block arrived; null when not seen live. */
  waiting: number | null;
}

/** The payout scripts an identity covers: those under its label, or its one script. */
export function scriptsOf(ctx: Context, id: string): string[] {
  return id.startsWith('label:')
    ? [...ctx.labels.byScript].filter(([, e]) => e.label === id.slice(6)).map(([script]) => script)
    : [id.slice(7)];
}

/** Newest first. `id` keeps one identity's blocks; `below` pages down from a height. */
export function recentBlocks(ctx: Context, limit: number, opts: { id?: string; below?: number } = {}): RecentBlock[] {
  const where: string[] = [];
  const params: (number | string)[] = [];
  if (opts.below !== undefined) {
    where.push('height < ?');
    params.push(opts.below);
  }
  if (opts.id !== undefined) {
    const scripts = scriptsOf(ctx, opts.id);
    if (scripts.length === 0) return [];
    where.push(`payout_script IN (${scripts.map(() => '?').join(', ')})`);
    params.push(...scripts);
  }
  const sql = `SELECT ${COLUMNS}, mempool_waiting, (SELECT p.time FROM blocks p WHERE p.height = blocks.height - 1) AS prev_time FROM blocks
    ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY height DESC LIMIT ?`;
  return rows(ctx, sql, ...params, limit).map((b) => {
    const prevTime = (b as unknown as { prev_time: number | null }).prev_time;
    const id = identityOf(b.payout_script, ctx.labels);
    return {
      height: b.height,
      hash: b.hash,
      time: b.time,
      interval: prevTime === null ? null : b.time - prevTime,
      id,
      name: identityName(id, ctx.network),
      reward: BigInt(b.reward),
      txCount: b.tx_count,
      vsize: b.vsize,
      certVersion: b.cert_version,
      certKind: b.cert_kind,
      tag: b.tag,
      payoutCount: b.payout_count,
      waiting: (b as unknown as { mempool_waiting: number | null }).mempool_waiting,
    };
  });
}

export interface SeriesPoint {
  time: number;
  height: number;
  rate: number;
  rateLo: number;
  rateHi: number;
  difficulty: number;
  meanInterval: number;
}

/** Work rate and difficulty in buckets of `per` blocks, oldest first. */
export function series(ctx: Context, window: WindowName, per: number): SeriesPoint[] {
  const { before, blocks } = windowBlocks(ctx, window);
  if (before === null) return [];
  const out: SeriesPoint[] = [];
  let start = before;
  for (let i = 0; i + per <= blocks.length; i += per) {
    const chunk = blocks.slice(i, i + per);
    const end = chunk[chunk.length - 1]!;
    const span = Math.max(1, end.time - start.time);
    const rate = chunk.reduce((s, b) => s + b.work, 0) / span;
    const ci = countInterval(per);
    out.push({ time: end.time, height: end.height, rate, rateLo: (rate * ci.lo) / per, rateHi: (rate * ci.hi) / per, difficulty: end.difficulty, meanInterval: span / per });
    start = end;
  }
  return out;
}

export interface Links {
  /** Transactions that spent coinbase outputs of this identity together with another's. */
  coSpent: { txid: string; height: number; with: string[] }[];
}

// Like the payout audit, a big pool's links read thousands of transactions and change slowly.
const linkCache = new Map<string, { at: number; links: Links }>();

export function links(ctx: Context, id: string): Links {
  const key = `${id}|${scriptsOf(ctx, id).length}`;
  const hit = linkCache.get(key);
  if (hit !== undefined && Date.now() - hit.at < 600_000) return hit.links;
  const found = findLinks(ctx, id);
  if (linkCache.size > 2000) linkCache.clear();
  linkCache.set(key, { at: Date.now(), links: found });
  return found;
}

function findLinks(ctx: Context, id: string): Links {
  const scripts = scriptsOf(ctx, id);
  if (scripts.length === 0) return { coSpent: [] };
  // Transactions that spend this miner's coinbases, with every coinbase each of them spends.
  const spends = ctx.store.db
    .prepare(
      `SELECT s.txid, s.height, p.script FROM spends s CROSS JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout
       WHERE s.txid IN (SELECT s2.txid FROM payouts p2 CROSS JOIN spends s2 ON s2.cb_txid = p2.txid AND s2.cb_vout = p2.vout
                        WHERE p2.script IN (${scripts.map(() => '?').join(', ')}))
       ORDER BY s.height DESC`,
    )
    .all(...scripts) as { txid: string; height: number; script: string }[];
  const byTx = new Map<string, { height: number; ids: Set<string> }>();
  for (const s of spends) {
    const t = byTx.get(s.txid) ?? { height: s.height, ids: new Set() };
    t.ids.add(identityOf(s.script, ctx.labels));
    byTx.set(s.txid, t);
  }
  const coSpent: Links['coSpent'] = [];
  for (const [txid, t] of byTx) {
    if (t.ids.has(id) && t.ids.size > 1) coSpent.push({ txid, height: t.height, with: [...t.ids].filter((x) => x !== id) });
  }
  return { coSpent };
}

export interface StaleRow {
  hash: string;
  height: number;
  time: number | null;
  name: string | null;
  source: string;
  seenAt: number;
}

export function stale(ctx: Context): StaleRow[] {
  const list = ctx.store.db.prepare('SELECT hash, height, time, payout_script, source, seen_at FROM stale ORDER BY height DESC').all() as {
    hash: string; height: number; time: number | null; payout_script: string | null; source: string; seen_at: number;
  }[];
  return list.map((s) => ({
    hash: s.hash,
    height: s.height,
    time: s.time,
    name: s.payout_script === null ? null : identityName(identityOf(s.payout_script, ctx.labels), ctx.network),
    source: s.source,
    seenAt: s.seen_at,
  }));
}

/** Seconds between consecutive block timestamps over the window; negative when a miner stamped before its parent. */
export function intervals(ctx: Context, window: WindowName): number[] {
  const { before, blocks } = windowBlocks(ctx, window);
  if (before === null) return [];
  let prev = before.time;
  return blocks.map((b) => {
    const d = b.time - prev;
    prev = b.time;
    return d;
  });
}

/** Each identity's blocks in consecutive buckets of `per` blocks, oldest first, for sparklines. */
export function shareHistory(ctx: Context, buckets: number, per: number): { per: number; counts: Map<string, number[]> } {
  const list = rows(ctx, `SELECT ${COLUMNS} FROM blocks ORDER BY height DESC LIMIT ?`, buckets * per).reverse();
  const counts = new Map<string, number[]>();
  const offset = buckets * per - list.length;
  list.forEach((b, i) => {
    const id = identityOf(b.payout_script, ctx.labels);
    const c = counts.get(id) ?? new Array<number>(buckets).fill(0);
    c[Math.floor((i + offset) / per)]! += 1;
    counts.set(id, c);
  });
  return { per, counts };
}

export interface PayoutAudit {
  /** Coinbase outputs paid to the identity, all time, in grain. */
  earned: bigint;
  /** Of those, spent on chain. */
  spent: bigint;
  /** Unspent and past coinbase maturity: free to spend, not spent. */
  heldMature: bigint;
  heldImmature: bigint;
  /** Transactions that spent its coinbases. */
  txs: number;
  /**
   * Distinct outside addresses those transactions paid. An address is the
   * identity's own, and left out, when one of these transactions later spends
   * what it was sent: that is change coming back.
   */
  payees: number;
  /**
   * What those addresses were paid, in grain. Null until the store has every
   * payout transaction's inputs (`backfill`), since without them change counts
   * as a payment. Also null for an identity that moves more to its own addresses
   * and out of sight than it pays to others: one that pays its miners from a
   * wallet, in transactions that spend none of its coinbases, cannot be followed.
   */
  sentOut: bigint | null;
  lastSpend: { height: number; time: number } | null;
}

// A big pool's audit reads up to a million payout outputs (over a second), and
// its totals barely move between blocks, so each one is kept for ten minutes.
const audits = new Map<string, { at: number; audit: PayoutAudit | null }>();

/** Where an identity's coinbase rewards went, as far as the indexed chain shows. */
export function payoutAudit(ctx: Context, id: string): PayoutAudit | null {
  const key = `${id}|${scriptsOf(ctx, id).length}`;
  const hit = audits.get(key);
  if (hit !== undefined && Date.now() - hit.at < 600_000) return hit.audit;
  const audit = computeAudit(ctx, id);
  if (audits.size > 2000) audits.clear();
  audits.set(key, { at: Date.now(), audit });
  return audit;
}

function computeAudit(ctx: Context, id: string): PayoutAudit | null {
  const scripts = scriptsOf(ctx, id);
  if (scripts.length === 0) return null;
  const marks = scripts.map(() => '?').join(', ');
  const db = ctx.store.db;
  const tip = ctx.store.tipHeight() ?? 0;
  const maturity = ctx.network.coinbaseMaturity;
  const sums = db
    .prepare(
      `SELECT
         COALESCE(SUM(p.value), 0) AS earned,
         COALESCE(SUM(CASE WHEN s.txid IS NOT NULL THEN p.value END), 0) AS spent,
         COALESCE(SUM(CASE WHEN s.txid IS NULL AND p.height <= ? THEN p.value END), 0) AS mature,
         COALESCE(SUM(CASE WHEN s.txid IS NULL AND p.height > ? THEN p.value END), 0) AS immature
       FROM payouts p LEFT JOIN spends s ON s.cb_txid = p.txid AND s.cb_vout = p.vout
       WHERE p.script IN (${marks})`,
    );
  sums.setReadBigInts(true);
  const t = sums.get(tip - maturity + 1, tip - maturity + 1, ...scripts) as { earned: bigint; spent: bigint; mature: bigint; immature: bigint };
  const spendTxs = `SELECT DISTINCT s.txid FROM payouts p CROSS JOIN spends s ON s.cb_txid = p.txid AND s.cb_vout = p.vout WHERE p.script IN (${marks})`;
  // Scripts the identity paid and then spent from in a later one of these transactions: its change addresses.
  const change = `SELECT DISTINCT c.script FROM spend_inputs i JOIN spend_outputs c ON c.txid = i.prev_txid AND c.vout = i.prev_vout
     WHERE i.txid IN (${spendTxs}) AND c.txid IN (${spendTxs})`;
  const out = db.prepare(
    `SELECT COUNT(DISTINCT o.script) AS payees, COALESCE(SUM(o.value), 0) AS sent FROM spend_outputs o
     WHERE o.txid IN (${spendTxs}) AND o.script NOT IN (${marks}) AND o.script NOT IN (${change})`,
  );
  out.setReadBigInts(true);
  const o = out.get(...scripts, ...scripts, ...scripts, ...scripts) as { payees: bigint; sent: bigint };
  // What these transactions sent to the identity's own scripts, and how much of that they later spent again.
  const keptQ = db.prepare(
    `SELECT COALESCE(SUM(o.value), 0) AS kept FROM spend_outputs o
     WHERE o.txid IN (${spendTxs}) AND (o.script IN (${marks}) OR o.script IN (${change}))`,
  );
  keptQ.setReadBigInts(true);
  const kept = (keptQ.get(...scripts, ...scripts, ...scripts, ...scripts) as { kept: bigint }).kept;
  const againQ = db.prepare(
    `SELECT COALESCE(SUM(c.value), 0) AS again FROM spend_inputs i JOIN spend_outputs c ON c.txid = i.prev_txid AND c.vout = i.prev_vout
     WHERE i.txid IN (${spendTxs}) AND c.txid IN (${spendTxs})`,
  );
  againQ.setReadBigInts(true);
  const again = (againQ.get(...scripts, ...scripts) as { again: bigint }).again;
  const followed = ctx.store.getMeta(INPUTS_COMPLETE) !== null && kept - again <= o.sent;
  const last = db
    .prepare(`SELECT MAX(s.height) AS height FROM (${spendTxs}) x JOIN spends s ON s.txid = x.txid`)
    .get(...scripts) as { height: number | null };
  const txs = (db.prepare(`SELECT COUNT(*) AS n FROM (${spendTxs})`).get(...scripts) as { n: number }).n;
  const lastTime = last.height === null ? null : (db.prepare('SELECT time FROM blocks WHERE height = ?').get(last.height) as { time: number } | undefined)?.time ?? null;
  return {
    earned: t.earned,
    spent: t.spent,
    heldMature: t.mature,
    heldImmature: t.immature,
    txs,
    payees: Number(o.payees),
    sentOut: followed ? o.sent : null,
    lastSpend: last.height === null || lastTime === null ? null : { height: last.height, time: lastTime },
  };
}

export interface Received {
  txid: string;
  height: number;
  time: number;
  value: bigint;
  /** Identities whose coinbases the paying transaction spent. */
  from: string[];
}

/**
 * Payments to a script from transactions that spend coinbases, newest first.
 * Transactions spending the identity's own coinbases are left out: that is
 * its change coming back, not a payment.
 */
export function receivedFromPools(ctx: Context, script: string, limit = 100): Received[] {
  const own = scriptsOf(ctx, identityOf(script, ctx.labels));
  const q = ctx.store.db.prepare(
    `SELECT o.txid AS txid, o.height AS height, b.time AS time, SUM(o.value) AS value FROM spend_outputs o JOIN blocks b ON b.height = o.height
     WHERE o.script = ? AND NOT EXISTS (
       SELECT 1 FROM spends s CROSS JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout
       WHERE s.txid = o.txid AND p.script IN (${own.map(() => '?').join(', ')}))
     GROUP BY o.txid ORDER BY o.height DESC LIMIT ?`,
  );
  q.setReadBigInts(true);
  const rowsOut = q.all(script, ...own, limit) as { txid: string; height: bigint; time: bigint; value: bigint }[];
  const fromQ = ctx.store.db.prepare('SELECT DISTINCT p.script AS script FROM spends s CROSS JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout WHERE s.txid = ?');
  return rowsOut.map((r) => ({
    txid: r.txid,
    height: Number(r.height),
    time: Number(r.time),
    value: r.value,
    from: [...new Set((fromQ.all(r.txid) as { script: string }[]).map((x) => identityOf(x.script, ctx.labels)))],
  }));
}

/** Blocks an identity mined in a window that carried only the coinbase, and how many of those left transactions waiting. */
export function emptyBlocks(ctx: Context, id: string, window: WindowName): { blocks: number; empty: number; seen: number; leftWaiting: number; fees: bigint } {
  const { blocks } = windowBlocks(ctx, window);
  const mine = blocks.filter((b) => identityOf(b.payout_script, ctx.labels) === id);
  const empties = mine.filter((b) => b.tx_count === 1);
  const heights = empties.map((b) => b.height);
  let seen = 0;
  let leftWaiting = 0;
  let fees = 0n;
  if (heights.length > 0) {
    const q = ctx.store.db.prepare(`SELECT mempool_waiting AS w, mempool_fees AS f FROM blocks WHERE height IN (${heights.map(() => '?').join(', ')}) AND mempool_waiting IS NOT NULL`);
    q.setReadBigInts(true);
    for (const r of q.all(...heights) as { w: bigint; f: bigint }[]) {
      seen += 1;
      if (r.w > 0n) {
        leftWaiting += 1;
        fees += r.f;
      }
    }
  }
  return { blocks: mine.length, empty: empties.length, seen, leftWaiting, fees };
}

/** How an identity's blocks in a window split by proof kind and certificate version. */
export function certificateMix(ctx: Context, id: string, window: WindowName): { kind: string; blocks: number }[] {
  const { blocks } = windowBlocks(ctx, window);
  const counts = new Map<string, number>();
  for (const b of blocks) {
    if (identityOf(b.payout_script, ctx.labels) !== id) continue;
    const k = b.cert_version === null ? 'none' : `V${b.cert_version} ${b.cert_kind}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts].map(([kind, n]) => ({ kind, blocks: n })).sort((a, b) => b.blocks - a.blocks);
}

export interface AllTime {
  id: string;
  name: string;
  labelled: boolean;
  blocks: number;
  lastHeight: number;
  lastTime: number;
  tags: string[];
  paysOut: boolean;
}

/** One identity over every indexed block, read for it alone. */
export function allTime(ctx: Context, id: string): AllTime | null {
  const scripts = scriptsOf(ctx, id);
  if (scripts.length === 0) return null;
  const marks = scripts.map(() => '?').join(', ');
  const s = ctx.store.db
    .prepare(`SELECT COUNT(*) AS n, MAX(height) AS h FROM blocks WHERE payout_script IN (${marks})`)
    .get(...scripts) as { n: number; h: number | null };
  if (s.n === 0 || s.h === null) return null;
  const last = ctx.store.db.prepare('SELECT time FROM blocks WHERE height = ?').get(s.h) as { time: number };
  const tags = (ctx.store.db.prepare(`SELECT tag FROM blocks WHERE payout_script IN (${marks})`).all(...scripts) as { tag: string | null }[]).map((r) => r.tag);
  const labelled = id.startsWith('label:');
  const paysOut =
    !labelled &&
    ctx.store.db
      .prepare(`SELECT 1 FROM payouts p CROSS JOIN spends s ON s.cb_txid = p.txid AND s.cb_vout = p.vout WHERE p.script IN (${marks}) AND s.outputs >= 10 LIMIT 1`)
      .get(...scripts) !== undefined;
  return { id, name: identityName(id, ctx.network), labelled, blocks: s.n, lastHeight: s.h, lastTime: last.time, tags: commonTags(tags), paysOut };
}

export interface Concentration {
  /** Fewest miners that together found more than half the blocks. */
  toHalf: number;
  /** Share of blocks found by the three largest. */
  top3: number;
  /** 1 / Σ share², the number of equal miners that would be as concentrated. */
  effective: number;
  /** Share of blocks paid to addresses with no name. */
  unnamed: number;
}

/**
 * How few miners hold the blocks, over the rows of a window. Each unnamed
 * address counts as a miner of its own; some may belong to one pool, so the
 * true figures can only be more concentrated than these.
 */
export function concentration(rows: MinerRow[]): Concentration | null {
  const total = rows.reduce((s, r) => s + r.blocks, 0);
  if (total === 0) return null;
  const shares = rows.map((r) => r.blocks / total).sort((a, b) => b - a);
  let toHalf = 0;
  let sum = 0;
  while (sum <= 0.5 && toHalf < shares.length) sum += shares[toHalf++]!;
  return {
    toHalf,
    top3: shares.slice(0, 3).reduce((s, x) => s + x, 0),
    effective: 1 / shares.reduce((s, x) => s + x * x, 0),
    unnamed: rows.filter((r) => !r.labelled).reduce((s, r) => s + r.blocks, 0) / total,
  };
}

export const feeOf = (ctx: Context, row: Pick<MinerRow, 'labelled' | 'name'>): Fee | null =>
  row.labelled ? ctx.fees?.find((f) => f.label === row.name) ?? null : null;
