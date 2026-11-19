// Grouping payout scripts into identities. An identity is one payout script
// unless labels.json names several scripts as one party. Labels are written
// by hand, each with its source; nothing here guesses who owns an address.
import { readFileSync } from 'node:fs';
import { fromOutputScript, toOutputScript, verifyMessage, type PearlNetwork } from 'pearljs';

export interface LabelEntry {
  label: string;
  /** Addresses or output scripts in hex. */
  scripts: string[];
  /** Where the attribution comes from: a URL, a signed message, the pool's own page. */
  source: string;
  note?: string;
}

export interface Labels {
  /** script hex to entry */
  byScript: Map<string, LabelEntry>;
  entries: LabelEntry[];
}

export interface Claim {
  /** An identity's label from labels.json. */
  label: string;
  /** Share of network hashrate the third party states, 0 to 1. */
  share?: number;
  /** Or a hashrate with the network hashrate from the same source, so the units cancel. */
  hashrate?: number;
  networkHashrate?: number;
  /** Unix seconds the claim was read, or the window it covers. */
  readAt: number;
  windowStart?: number;
  windowEnd?: number;
  source: string;
}

export const emptyLabels = (): Labels => ({ byScript: new Map(), entries: [] });

export function parseLabels(raw: string, network: PearlNetwork): Labels {
  const doc = JSON.parse(raw) as { identities?: LabelEntry[] };
  const labels = emptyLabels();
  for (const entry of doc.identities ?? []) {
    if (typeof entry.label !== 'string' || entry.label === '') throw new Error('labels.json: an identity without a label');
    if (typeof entry.source !== 'string' || entry.source === '') throw new Error(`labels.json: ${entry.label} has no source`);
    for (const s of entry.scripts) {
      const script = /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? s.toLowerCase() : Buffer.from(toOutputScript(s, network)).toString('hex');
      const prior = labels.byScript.get(script);
      if (prior !== undefined && prior !== entry) throw new Error(`labels.json: ${s} is under both ${prior.label} and ${entry.label}`);
      labels.byScript.set(script, entry);
    }
    labels.entries.push(entry);
  }
  return labels;
}

export function loadLabels(path: string, network: PearlNetwork): Labels {
  try {
    return parseLabels(readFileSync(path, 'utf8'), network);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyLabels();
    throw err;
  }
}

/** Hand-written labels first; a script they already name is dropped from the later files. */
export function mergeLabels(first: Labels, ...rest: Labels[]): Labels {
  const out: Labels = { byScript: new Map(first.byScript), entries: [...first.entries] };
  for (const l of rest) {
    for (const entry of l.entries) {
      const own = [...l.byScript].filter(([s, e]) => e === entry && !out.byScript.has(s));
      if (own.length === 0) continue;
      const kept = { ...entry, scripts: own.map(([s]) => s) };
      out.entries.push(kept);
      for (const [s] of own) out.byScript.set(s, kept);
    }
  }
  return out;
}

export function parseClaims(raw: string): Claim[] {
  const doc = JSON.parse(raw) as { claims?: Claim[] };
  const claims = doc.claims ?? [];
  for (const c of claims) {
    if (c.share === undefined && (c.hashrate === undefined || c.networkHashrate === undefined)) {
      throw new Error(`claims.json: ${c.label} needs a share, or a hashrate with the network hashrate from the same source`);
    }
    if (typeof c.source !== 'string' || c.source === '') throw new Error(`claims.json: ${c.label} has no source`);
  }
  return claims;
}

export function loadClaims(path: string): Claim[] {
  try {
    return parseClaims(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export const claimedShare = (c: Claim): number => c.share ?? c.hashrate! / c.networkHashrate!;

/** The identity key a payout script belongs to: `label:<name>` or `script:<hex>`. */
export function identityOf(script: string, labels: Labels): string {
  const entry = labels.byScript.get(script);
  return entry === undefined ? `script:${script}` : `label:${entry.label}`;
}

export function identityName(id: string, network: PearlNetwork): string {
  if (id.startsWith('label:')) return id.slice(6);
  const hex = id.slice(7);
  if (hex === 'none') return 'no payout';
  try {
    return fromOutputScript(Buffer.from(hex, 'hex'), network);
  } catch {
    return hex;
  }
}

/**
 * The exact text a pool signs with an address to prove the address is its
 * own. The signature is checked against the address, and the text names the
 * pool, so it cannot be moved to another address or another pool. Oyster
 * signs at most 80 bytes, which leaves 68 for the name.
 */
export function proofMessage(pool: string): string {
  const text = `Pearl pool: ${pool}`;
  if (Buffer.byteLength(text) > 80) throw new Error(`pool name too long to sign: ${pool}`);
  return text;
}

export interface SignedName {
  pool: string;
  address: string;
  /** Base64, from Oyster's signmessage or pearljs's signMessage. */
  signature: string;
}

/**
 * Names from signed-names.json whose signature verifies with pearljs over
 * proofMessage; the rest come back as rejected, so the caller can say so.
 */
export function parseSignedNames(raw: string, network: PearlNetwork): { labels: Labels; rejected: SignedName[] } {
  const doc = JSON.parse(raw) as { names?: SignedName[] };
  const labels = emptyLabels();
  const rejected: SignedName[] = [];
  for (const n of doc.names ?? []) {
    let ok = false;
    try {
      ok = verifyMessage(n.address, n.signature, proofMessage(n.pool), network);
    } catch {
      ok = false;
    }
    if (!ok) {
      rejected.push(n);
      continue;
    }
    const script = Buffer.from(toOutputScript(n.address, network)).toString('hex');
    if (labels.byScript.has(script)) continue;
    const entry = { label: n.pool, scripts: [script], source: 'signed by the address' };
    labels.entries.push(entry);
    labels.byScript.set(script, entry);
  }
  return { labels, rejected };
}

export function loadSignedNames(path: string, network: PearlNetwork): { labels: Labels; rejected: SignedName[] } {
  try {
    return parseSignedNames(readFileSync(path, 'utf8'), network);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { labels: emptyLabels(), rejected: [] };
    throw err;
  }
}
