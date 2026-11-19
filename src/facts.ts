// What one block says about its miner, read from the block alone.
import {
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
}

export interface CoinbaseSpend {
  txid: string;
  inputs: number;
  outputs: number;
  /** The coinbase outputs this transaction spends, as txid:vout. */
  spent: string[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

// Runs of 4 or more printable ASCII bytes. The script starts with pushes of
// the height and an extra nonce, which are binary and fall out here.
export function coinbaseTag(script: Uint8Array): string | null {
  const runs = Buffer.from(script)
    .toString('latin1')
    .match(/[\x20-\x7e]{4,}/g);
  return runs === null ? null : runs.join(' ').trim() || null;
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
  };
}

/** Transactions in the block that spend any of the outpoints `isCoinbaseOutput` recognises. */
export function coinbaseSpends(block: PearlBlock, isCoinbaseOutput: (outpoint: string) => boolean): CoinbaseSpend[] {
  const found: CoinbaseSpend[] = [];
  for (const tx of block.transactions.slice(1)) {
    const spent = tx.ins
      .map((input) => `${hex(Uint8Array.from(input.hash).reverse())}:${input.index}`)
      .filter(isCoinbaseOutput);
    if (spent.length > 0) found.push({ txid: tx.getId(), inputs: tx.ins.length, outputs: tx.outs.length, spent });
  }
  return found;
}
