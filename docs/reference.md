# Reference

## Pages and API

- `/` headline numbers, the top ten miners, hashrate and block-time charts, latest blocks. `?window=day|week|month|all` picks the last 445, 3,118 or 13,361 blocks, or all of them.
- `/miners` every miner, with a ranking chart of shares, their likely ranges and what pools say.
- `/miner/<id>` one miner: its numbers, its pool claim against what it found, where its coinbase rewards went (earned, spent, held, how many addresses it paid), its empty blocks and whether transactions were waiting when it mined them, its proof types, its addresses and coinbase tags, and other addresses it shares an owner with.
- `/address/<address>` one address: what it mined, and the payments it received from transactions that spend pool coinbases. Typing an address into the miners search goes here.
- `/blocks` every block, newest first, and the stale blocks this node saw.
- `/api/network.json`, `/api/miners.json`, `/api/blocks.json`, `/api/stale.json`.

Hovering a share or hashrate shows its range.

## What it can and cannot tell you

The question it started from was why a pool does not publish its measured hashrate or its effort per block. Those two numbers come from the shares miners send a pool, and shares never reach the chain, so only the pool can publish them. This dashboard cannot.

What it answers from public data alone:

- Who was paid for each block, and each address's or labelled pool's share of the last day, week or month of blocks, with an exact 95% interval.
- An estimated hashrate per miner and for the network, in pearld's units (the same as `getnetworkhashps`), with an interval.
- Whether a pool's published share or hashrate is consistent with the blocks its labelled addresses found, as a probability.
- Network effort and block times against the 194-second target, difficulty, empty blocks, fees claimed over the subsidy, certificate versions, and stale blocks this node saw.
- Addresses whose coinbase outputs were spent together, or paid out to many addresses, as evidence for grouping them.

What it cannot answer: a pool's own share-based hashrate and effort, which addresses belong to which pool unless someone with a source says so, and stale blocks this node never heard of.

## How pearljs is used

| pearljs | What it does here | Where |
| --- | --- | --- |
| `watchChain` with `ws` | Follows the best chain block by block from a stored cursor, undoes reorganised blocks, and wakes on pearld's block notifications | `src/indexer.ts` |
| `PearldClient`, `PearlWsClient` | RPC and websocket to pearld over TLS, with undici trusting pearld's `rpc.cert` | `src/node.ts` |
| `inspectTransaction` | Reads each coinbase: payouts, their addresses, the reward and witness commitment | `src/facts.ts` |
| `checkMerkleRoot`, `checkWitnessCommitment`, `checkCertificateBinding`, `checkCertificateRules` | Checks every indexed block; a failure is logged and kept with the block | `src/facts.ts` |
| `workForBits`, `difficultyForBits`, `blockSubsidy` | Work, difficulty and subsidy of each block, for hashrate and fees | `src/facts.ts` |
| `isMoECertificate`, certificate versions | Which proof kind and version each block carries | `src/facts.ts` |
| `toOutputScript`, `fromOutputScript` | Addresses to payout scripts and back, for labels and pages | `src/labels.ts` |
| `verifyMessage` | Checks a pool's signed claim to an address | `src/labels.ts` |
| `PearldClient.getRawMempoolVerbose` | The mempool when each block arrives, for the empty-block check | `src/indexer.ts` |
| `isValidAddress` | The address pages and address search | `src/views.ts`, `src/server.ts` |
| `parseBlock`, `PearldClient.getRawBlock` | Re-reading past blocks for their payouts | `src/cli.ts` |
| `SimulatedChain`, `testAddress`, `testAccount` | Every test, and the demo: miners, reorgs, restarts and coinbase spends without a node | `test/`, `src/demo.ts` |
| `startRegtest` | The live test against a real pearld | `test-live/regtest.test.ts` |

What pearljs did not cover is written down in [PEARLJS-GAPS.md](../PEARLJS-GAPS.md).

## Tests

```bash
npm test
```

35 tests run against `pearljs/testing`'s simulated chain: the statistics against values from scipy, the indexer through reorganisations while running and while stopped, pearljs's block checks, coinbase co-spends, pool naming from feeds, trackers and spending, coinbase tags taken from mainnet blocks, signed names, claims, and the pages. One more runs against a real regtest pearld fed saved blocks (a JSON array of block hex, as `getblock <hash> 0` returns it):

```bash
PEARLD=/path/to/pearld PEARL_CHAIN=/path/to/saved-blocks.json npx vitest run --config vitest.live.config.ts
```

## Limits

- The simulated chain never changes difficulty, so the demo's difficulty figures do not move.
- An identity is the address of the largest coinbase output. A pool that pays every miner straight from the coinbase shows as its largest payee, and a pool that rotates addresses shows as several miners until a pool feed, a tracker or a co-spend names them.
- Solo pools' blocks pay the miner who found them; those addresses are named "<pool> Solo", not as the pool.
- Testnet stops at height 67370, where certificates move to V4, until pearljs parses them. See [PEARLJS-GAPS.md](../PEARLJS-GAPS.md).
- The indexer keeps up with a syncing node at about 3,000 blocks a minute; a full node sync is the slow part (see [running.md](running.md)).
