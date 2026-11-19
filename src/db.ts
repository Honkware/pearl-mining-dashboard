// SQLite storage for per-block facts. One row per block of the best chain;
// a block that leaves the chain moves to `stale` with what it paid.
import { DatabaseSync } from 'node:sqlite';
import type { FollowCursor } from 'pearljs';
import type { BlockFacts, CoinbaseSpend } from './facts.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (
  height INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  prev TEXT NOT NULL,
  time INTEGER NOT NULL,
  bits INTEGER NOT NULL,
  difficulty REAL NOT NULL,
  work REAL NOT NULL,
  cert_version INTEGER,
  cert_kind TEXT,
  tx_count INTEGER NOT NULL,
  size INTEGER NOT NULL,
  vsize INTEGER NOT NULL,
  coinbase_txid TEXT NOT NULL,
  reward INTEGER NOT NULL,
  subsidy INTEGER NOT NULL,
  tag TEXT,
  coinbase_data TEXT NOT NULL,
  payout_script TEXT NOT NULL,
  payout_count INTEGER NOT NULL,
  check_failed TEXT
);
CREATE INDEX IF NOT EXISTS blocks_time ON blocks (time);
CREATE INDEX IF NOT EXISTS blocks_payout ON blocks (payout_script, height);
CREATE TABLE IF NOT EXISTS payouts (
  height INTEGER NOT NULL,
  txid TEXT NOT NULL,
  vout INTEGER NOT NULL,
  value INTEGER NOT NULL,
  script TEXT NOT NULL,
  address TEXT,
  PRIMARY KEY (txid, vout)
);
CREATE INDEX IF NOT EXISTS payouts_height ON payouts (height);
CREATE INDEX IF NOT EXISTS payouts_script ON payouts (script);
CREATE TABLE IF NOT EXISTS spends (
  height INTEGER NOT NULL,
  txid TEXT NOT NULL,
  inputs INTEGER NOT NULL,
  outputs INTEGER NOT NULL,
  cb_txid TEXT NOT NULL,
  cb_vout INTEGER NOT NULL,
  PRIMARY KEY (txid, cb_txid, cb_vout)
);
CREATE INDEX IF NOT EXISTS spends_height ON spends (height);
CREATE INDEX IF NOT EXISTS spends_cb ON spends (cb_txid, cb_vout);
CREATE TABLE IF NOT EXISTS stale (
  hash TEXT PRIMARY KEY,
  height INTEGER NOT NULL,
  time INTEGER,
  payout_script TEXT,
  reward INTEGER,
  source TEXT NOT NULL,
  seen_at INTEGER NOT NULL
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    // The indexer writes while the web server reads the same file; wait for a lock instead of failing.
    this.db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;');
    this.db.exec(SCHEMA);
    // Stores made before blocks were checked lack the column; their blocks count as unchecked (NULL).
    const cols = this.db.prepare('PRAGMA table_info(blocks)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'check_failed')) {
      try {
        this.db.exec('ALTER TABLE blocks ADD COLUMN check_failed TEXT');
      } catch (err) {
        // The indexer and the web server open the store together; the other one may have just added it.
        if (!String(err).includes('duplicate column')) throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  /** Runs fn in one transaction: the block's rows and the cursor land together or not at all. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  cursor(): FollowCursor | null {
    const raw = this.getMeta('cursor');
    return raw === null ? null : (JSON.parse(raw) as FollowCursor);
  }

  setCursor(cursor: FollowCursor): void {
    this.setMeta('cursor', JSON.stringify(cursor));
  }

  isCoinbaseOutput(outpoint: string): boolean {
    const [txid, vout] = outpoint.split(':');
    return this.db.prepare('SELECT 1 FROM payouts WHERE txid = ? AND vout = ?').get(txid!, Number(vout)) !== undefined;
  }

  connect(f: BlockFacts, spends: CoinbaseSpend[]): void {
    this.db
      .prepare(
        `INSERT INTO blocks (height, hash, prev, time, bits, difficulty, work, cert_version, cert_kind, tx_count, size, vsize,
          coinbase_txid, reward, subsidy, tag, coinbase_data, payout_script, payout_count, check_failed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        f.height, f.hash, f.prev, f.time, f.bits, f.difficulty, f.work, f.certVersion, f.certKind, f.txCount, f.size, f.vsize,
        f.coinbaseTxid, f.reward, f.subsidy, f.tag, JSON.stringify(f.coinbaseData), f.payoutScript, f.payouts.length, f.checkFailed,
      );
    const payout = this.db.prepare('INSERT INTO payouts (height, txid, vout, value, script, address) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of f.payouts) payout.run(f.height, f.coinbaseTxid, p.vout, p.value, p.script, p.address);
    const spend = this.db.prepare('INSERT OR IGNORE INTO spends (height, txid, inputs, outputs, cb_txid, cb_vout) VALUES (?, ?, ?, ?, ?, ?)');
    for (const s of spends) {
      for (const outpoint of s.spent) {
        const [txid, vout] = outpoint.split(':');
        spend.run(f.height, s.txid, s.inputs, s.outputs, txid!, Number(vout));
      }
    }
  }

  /** Undoes the newest block, keeping a record of it as stale. */
  disconnect(height: number, hash: string, seenAt: number): void {
    const row = this.db.prepare('SELECT hash, time, payout_script, reward FROM blocks WHERE height = ?').get(height) as
      | { hash: string; time: number; payout_script: string; reward: number | bigint }
      | undefined;
    if (row === undefined || row.hash !== hash) throw new Error(`disconnect of ${hash} at ${height}, but the store has ${row?.hash ?? 'nothing'} there`);
    const top = this.db.prepare('SELECT MAX(height) AS h FROM blocks').get() as { h: number };
    if (top.h !== height) throw new Error(`disconnect at ${height} below the store's tip ${top.h}`);
    this.db
      .prepare('INSERT OR REPLACE INTO stale (hash, height, time, payout_script, reward, source, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(hash, height, row.time, row.payout_script, row.reward, 'reorg', seenAt);
    this.db.prepare('DELETE FROM spends WHERE height = ?').run(height);
    this.db.prepare('DELETE FROM payouts WHERE height = ?').run(height);
    this.db.prepare('DELETE FROM blocks WHERE height = ?').run(height);
  }

  /** A side-branch tip the node knows of, from getchaintips. Kept only if not already recorded. */
  noteForkTip(hash: string, height: number, time: number | null, seenAt: number): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO stale (hash, height, time, payout_script, reward, source, seen_at) VALUES (?, ?, ?, NULL, NULL, ?, ?)')
      .run(hash, height, time, 'chaintips', seenAt);
    return Number(r.changes) > 0;
  }

  tipHeight(): number | null {
    const row = this.db.prepare('SELECT MAX(height) AS h FROM blocks').get() as { h: number | null };
    return row.h;
  }
}
