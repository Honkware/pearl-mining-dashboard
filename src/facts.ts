// What one block says about its miner, read from the block alone.
import {
  checkCertificateBinding,
  checkCertificateRules,
  checkMerkleRoot,
  checkWitnessCommitment,
  blockSize,
  blockSubsidy,
  blockVsize,
  difficultyForBits,
  inspectTransaction,
  isMoECertificate,
  workForBits,
  type PearlBlock,
  type PearlNetwork,
} from 'pearljs';

export interface Payout {
  vout: number;
  value: bigint;
  script: string;
  address: string | null;
}

export interface BlockFacts {
  height: number;
  hash: string;
  prev: string;
  time: number;
  bits: number;
  difficulty: number;
  /** CalcWork as a float: exact work exceeds 2^53 on mainnet, and only sums and ratios of it are shown. */
  work: number;
  certVersion: number | null;
  certKind: 'dense' | 'moe' | null;
  txCount: number;
  size: number;
  vsize: number;
  coinbaseTxid: string;
  reward: bigint;
  subsidy: bigint;
  /** Printable text the miner put in the coinbase script after the height, if any. Self-declared. */
  tag: string | null;
  /** OP_RETURN payloads other than the witness commitment, hex. */
  coinbaseData: string[];
  payouts: Payout[];
  /** Script of the largest paying output: what identifies the miner. */
  payoutScript: string;
  /** null when every pearljs check passed, else the first that failed. */
  checkFailed: string | null;
}

export interface CoinbaseSpend {
  txid: string;
  inputs: number;
  outputs: number;
  /** The coinbase outputs this transaction spends, as txid:vout. */
  spent: string[];
  /** Its other inputs, as txid:vout: the pool's change comes back through these. */
  others: string[];
  /** What it pays, output by output. */
  outs: { vout: number; value: bigint; script: string }[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// pearld's own template flag; it says which software built the block, not who mined it.
export const DEFAULT_TAG = '/P2SH/pearld/';

/**
 * The miner's own words out of the printable runs of a coinbase script: the
 * parts between slashes that read as names (5 or more characters, 3 of them
 * letters), other than pearld's default flag, as "/pool.kryptex.com/". Bytes of
 * the height or extra nonce that happen to be printable ("Yj/pearl-pool/") fall
 * away. A run with no slashes is kept when it reads like a sentence.
 */
// Pools write the same few tags on thousands of blocks; each distinct one is cleaned once.
const cleaned = new Map<string, string>();
export function cleanTag(raw: string): string {
  let v = cleaned.get(raw);
  if (v === undefined) {
    if (cleaned.size > 100_000) cleaned.clear();
    cleaned.set(raw, (v = cleanTagOnce(raw)));
  }
  return v;
}

function cleanTagOnce(raw: string): string {
  if (raw.includes('/')) {
    const names = raw
      .split(/[/\s]+/)
      .filter((t) => /^[A-Za-z0-9][A-Za-z0-9._-]{4,}$/.test(t) && (t.match(/[A-Za-z]/g) ?? []).length >= 3 && t !== 'pearld' && t !== 'P2SH');
    return [...new Set(names)].map((t) => `/${t}/`).join(' ');
  }
  const words = raw.match(/[A-Za-z][A-Za-z0-9 .,'-]{7,}/g);
  return words === null ? '' : words.join(' ').trim();
}

// Runs of 4 or more printable ASCII bytes. The script starts with pushes of
// the height and an extra nonce, which are binary and mostly fall out here.
export function coinbaseTag(script: Uint8Array): string | null {
  const runs = Buffer.from(script)
    .toString('latin1')
    .match(/[\x20-\x7e]{4,}/g);
  return runs === null ? null : cleanTag(runs.join(' ')) || null;
}

/**
 * pearljs's own checks of a block pearld accepted: the header's Merkle root,
 * the coinbase's witness commitment, the certificate's binding to the header
 * and its version for the height. Returns the first failure, or null. The
 * hardcoded genesis block is skipped; it is built outside these rules.
 */
export function checkBlock(block: PearlBlock, height: number, network: PearlNetwork): string | null {
  if (height === 0) return null;
  const checks: [string, () => void][] = [
    ['checkMerkleRoot', () => checkMerkleRoot(block)],
    ['checkWitnessCommitment', () => checkWitnessCommitment(block)],
    ['checkCertificateBinding', () => checkCertificateBinding(block)],
    ['checkCertificateRules', () => checkCertificateRules(block.certificate, network, height)],
  ];
  for (const [name, run] of checks) {
    try {
      run();
    } catch (err) {
      return `${name}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return null;
}

export function blockFacts(block: PearlBlock, height: number, hash: string, network: PearlNetwork): BlockFacts {
  const coinbase = block.transactions[0]!;
  const inspected = inspectTransaction(coinbase, [], network, { height });
  const info = inspected.coinbase!;
  const payouts: Payout[] = [];
  const coinbaseData: string[] = [];
  inspected.outputs.forEach((out, vout) => {
    if (out.type === 'nulldata') {
      if (vout !== info.witnessCommitmentIndex) coinbaseData.push(hex(out.script));
      return;
    }
    if (out.value > 0n) payouts.push({ vout, value: out.value, script: hex(out.script), address: out.address });
  });
  // A coinbase that pays nothing to a script (all burned) still needs an identity.
  const top = payouts.reduce<Payout | null>((best, p) => (best === null || p.value > best.value ? p : best), null);
  const cert = block.certificate;
  return {
    height,
    hash,
    prev: hex(Uint8Array.from(block.header.prevBlock).reverse()),
    time: block.header.timestamp,
    bits: block.header.bits,
    difficulty: difficultyForBits(block.header.bits, network),
    work: Number(workForBits(block.header.bits)),
    certVersion: cert?.version ?? null,
    certKind: cert === null ? null : isMoECertificate(cert) ? 'moe' : 'dense',
    txCount: block.transactions.length,
    size: blockSize(block),
    vsize: blockVsize(block),
    coinbaseTxid: inspected.txid,
    reward: info.reward,
    subsidy: blockSubsidy(network, height),
    tag: coinbaseTag(info.script),
    coinbaseData,
    payouts,
    payoutScript: top?.script ?? 'none',
    checkFailed: checkBlock(block, height, network),
  };
}

/** Transactions in the block that spend any of the outpoints `isCoinbaseOutput` recognises. */
export function coinbaseSpends(block: PearlBlock, isCoinbaseOutput: (outpoint: string) => boolean): CoinbaseSpend[] {
  const found: CoinbaseSpend[] = [];
  for (const tx of block.transactions.slice(1)) {
    const inputs = tx.ins.map((input) => `${hex(Uint8Array.from(input.hash).reverse())}:${input.index}`);
    const spent = inputs.filter(isCoinbaseOutput);
    if (spent.length > 0) {
      const outs = tx.outs.map((o, vout) => ({ vout, value: o.value, script: hex(o.script) }));
      const others = inputs.filter((i) => !spent.includes(i));
      found.push({ txid: tx.getId(), inputs: tx.ins.length, outputs: tx.outs.length, spent, others, outs });
    }
  }
  return found;
}
