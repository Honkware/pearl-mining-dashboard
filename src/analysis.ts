// Window statistics over the store. A window is the last N blocks, not a
// span of clock time: the block count is then fixed, which is what the
// binomial intervals condition on, and a node that is behind or a test chain
// with its own clock gives the same answers as a current one. The sizes are
// a day, a week and 30 days of 194-second blocks.
import type { PearlNetwork } from 'pearljs';
import type { Store } from './db.js';
import { claimedShare, identityName, identityOf, type Claim, type Labels } from './labels.js';
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
  reward: bigint;
  subsidy: bigint;
  tag: string | null;
  payout_script: string;
  payout_count: number;
}

export interface Context {
  store: Store;
  network: PearlNetwork;
  labels: Labels;
  claims: Claim[];
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

function rows(ctx: Context, sql: string, ...params: (number | string)[]): BlockRow[] {
  const stmt = ctx.store.db.prepare(sql);
  stmt.setReadBigInts(true);
  // Amounts in grain stay exact as bigint; every other integer column fits a number.
  return stmt.all(...params).map((r) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) row[k] = typeof v === 'bigint' && k !== 'reward' && k !== 'subsidy' ? Number(v) : v;
    return row as unknown as BlockRow;
  });
}

const COLUMNS = 'height, hash, time, bits, difficulty, work, cert_version, cert_kind, tx_count, vsize, reward, subsidy, tag, payout_script, payout_count';

export function tipTime(ctx: Context): number | null {
  const row = ctx.store.db.prepare('SELECT time FROM blocks ORDER BY height DESC LIMIT 1').get() as { time: number } | undefined;
  return row?.time ?? null;
}

/** The window's blocks, plus the one before it, whose timestamp starts the span. */
function windowBlocks(ctx: Context, window: WindowName): { before: BlockRow | null; blocks: BlockRow[] } {
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
    reward: blocks.reduce((s, b) => s + b.reward, 0n),
    feesClaimed: blocks.reduce((s, b) => s + (b.reward > b.subsidy ? b.reward - b.subsidy : 0n), 0n),
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
    (ctx.store.db.prepare('SELECT DISTINCT p.script AS script FROM spends s JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout WHERE s.outputs >= 10').all() as { script: string }[]).map((r) => r.script),
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
    const claim = labelled ? claimFor(ctx, name, tip) : null;
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
      tags: [...new Set(g.blocks.map((b) => (b.tag === null ? null : cleanTag(b.tag))).filter((t): t is string => t !== null && t !== '' && t !== DEFAULT_TAG))],
      paysOut: !labelled && [...g.scripts].some((s) => payers.has(s)),
      claim: test,
    });
  }
  return out.sort((a, b) => b.blocks - a.blocks || b.lastHeight - a.lastHeight);
}

/** Share of the window's blocks found by the top `n` identities, for n = 1 up to `upTo`. */
export function concentration(rowsByShare: MinerRow[], total: number, upTo = 5): { top: number; blocks: number; share: number; interval: Interval }[] {
  const out = [];
  let k = 0;
  for (let i = 0; i < Math.min(upTo, rowsByShare.length); i++) {
    k += rowsByShare[i]!.blocks;
    out.push({ top: i + 1, blocks: k, share: k / total, interval: shareInterval(k, total) });
  }
  return out;
}

/** Fewest identities that together found more than half the window's blocks. */
export function nakamoto(rowsByShare: MinerRow[], total: number): number {
  let k = 0;
  for (let i = 0; i < rowsByShare.length; i++) {
    k += rowsByShare[i]!.blocks;
    if (2 * k > total) return i + 1;
  }
  return rowsByShare.length;
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
    const scripts = opts.id.startsWith('label:')
      ? [...ctx.labels.byScript].filter(([, e]) => e.label === opts.id!.slice(6)).map(([script]) => script)
      : [opts.id.slice(7)];
    if (scripts.length === 0) return [];
    where.push(`payout_script IN (${scripts.map(() => '?').join(', ')})`);
    params.push(...scripts);
  }
  const sql = `SELECT ${COLUMNS}, (SELECT p.time FROM blocks p WHERE p.height = blocks.height - 1) AS prev_time FROM blocks
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
      reward: b.reward,
      txCount: b.tx_count,
      vsize: b.vsize,
      certVersion: b.cert_version,
      certKind: b.cert_kind,
      tag: b.tag,
      payoutCount: b.payout_count,
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
  /** Transactions spending this identity's coinbase outputs into many outputs, as a pool paying its miners does. */
  fanOut: { txid: string; height: number; outputs: number }[];
}

export function links(ctx: Context, id: string, fanOutAt = 10): Links {
  const spends = ctx.store.db
    .prepare(
      `SELECT s.txid, s.height, s.outputs, p.script FROM spends s JOIN payouts p ON p.txid = s.cb_txid AND p.vout = s.cb_vout
       WHERE s.txid IN (SELECT s2.txid FROM spends s2 JOIN payouts p2 ON p2.txid = s2.cb_txid AND p2.vout = s2.cb_vout)
       ORDER BY s.height DESC`,
    )
    .all() as { txid: string; height: number; outputs: number; script: string }[];
  const byTx = new Map<string, { height: number; outputs: number; ids: Set<string> }>();
  for (const s of spends) {
    const t = byTx.get(s.txid) ?? { height: s.height, outputs: s.outputs, ids: new Set() };
    t.ids.add(identityOf(s.script, ctx.labels));
    byTx.set(s.txid, t);
  }
  const coSpent: Links['coSpent'] = [];
  const fanOut: Links['fanOut'] = [];
  for (const [txid, t] of byTx) {
    if (!t.ids.has(id)) continue;
    if (t.ids.size > 1) coSpent.push({ txid, height: t.height, with: [...t.ids].filter((x) => x !== id) });
    if (t.outputs >= fanOutAt) fanOut.push({ txid, height: t.height, outputs: t.outputs });
  }
  return { coSpent, fanOut };
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
