# pearl-mining-dashboard

Who mines Pearl blocks, read from a pearld node: each payout address's share of blocks with a 95% interval, an estimated hashrate in pearld's units, network hashrate, difficulty, block times and effort, and a check of what pools claim against the blocks they actually found.

It is a TypeScript server built on `pearljs`, the TypeScript SDK for Pearl in the sibling folder. The indexer follows the node's best chain, wakes on pearld's block notifications, checks each block with pearljs, survives reorganisations and restarts, and keeps one row per block in SQLite. The web server renders the pages from that database, with a small JSON API. The `pools` command names pools from what they publish about themselves and reads their hashrate claims.

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
| `SimulatedChain`, `testAddress`, `testAccount` | Every test, and the demo: miners, reorgs, restarts and coinbase spends without a node | `test/`, `src/demo.ts` |
| `startRegtest` | The live test against a real pearld | `test-live/regtest.test.ts` |

What pearljs did not cover is written down in `PEARLJS-GAPS.md`.

## Run the demo

The demo builds a seeded simulated chain of 3,600 blocks with a mix of miners shaped like mainnet's (made-up pools named Pool A to Pool E), indexes it and serves it. No node is needed.

```bash
npm install
```

```bash
npm run build
```

```bash
node --no-warnings=ExperimentalWarning dist/cli.js demo
```

Then open http://127.0.0.1:8080. Building the chain takes about 30 seconds.

Node 22.13 or newer is needed for `node:sqlite`. `pearljs` comes from the sibling folder `../pearljs` (`file:` dependency); build it there first with `npm run build` if `../pearljs/dist` is missing.

## Run it against a real node

### 1. pearld

Build pearld from the Pearl source as `.work/regtest/scripts/build.sh` does (`go build -tags xmss,zkpow -o pearld ./node` after building the zk-pow Rust bindings), or use a release binary. Give it a limited RPC user in `pearld.conf` in its home directory, so the passwords stay off the command line:

```
rpcuser=admin
rpcpass=<a long random password>
rpclimituser=dashboard
rpclimitpass=<another long random password>
rpclisten=127.0.0.1:44107
```

Then start it on mainnet, which is its default:

```bash
pearld
```

Every method the dashboard calls (`getbestblock`, `getblockhash`, `getblock`, `getblockcount`, `getblockheader`, `getchaintips`) is open to pearld's limited user. No `--txindex` or `--addrindex` is needed: fees are read from the coinbase, and spends of coinbase outputs are seen as the indexer passes each block. pearld writes its TLS certificate to `rpc.cert` in its home directory (`~/Library/Application Support/Pearld` on macOS, `~/.pearld` on Linux).

A full mainnet node downloads the whole chain from peers found through Pearl's DNS seeds; that takes disk, bandwidth and time this README has not measured. Running one is your call.

### 2. Indexer

```bash
export PEARL_NETWORK=mainnet PEARLD_URL=https://127.0.0.1:44107 PEARLD_USER=dashboard PEARLD_PASS=... PEARLD_CERT="$HOME/Library/Application Support/Pearld/rpc.cert"
```

```bash
node --no-warnings=ExperimentalWarning dist/cli.js index
```

It starts at genesis (or `START_HEIGHT`), logs every 1000th block, waits at the tip for new blocks (woken by pearld's websocket, with a poll as backup), and resumes from its stored cursor after a restart. Each block goes through pearljs's block checks; a failure is logged as `[index] block N <hash> failed <check>` and stored with the block. `STOP_AT_TIP=1` makes it exit at the tip instead. Data goes to `data/mainnet.sqlite` (`DATA_DIR` to change it).

### 3. Web server

In a second shell with the same environment:

```bash
node --no-warnings=ExperimentalWarning dist/cli.js serve
```

It listens on 127.0.0.1:8080 (`HOST`, `PORT`) and shows a banner while the indexer is behind the node.

### Pool names and claims

```bash
node --no-warnings=ExperimentalWarning dist/cli.js pools
```

`pools` reads each pool's public API (block hashes, its coinbase wallet, or its payout transactions), matches it against the indexed chain, and writes `pool-labels.json` and `pool-claims.json` in `DATA_DIR`, with a dated copy of everything it read under `sources/`. It then fills in addresses that PearlStation and PearlTrack name, and gives an unnamed address the name of any named address whose coinbases it was spent together with. Run it again after the indexer reaches the tip, and now and then, since pool feeds only cover recent blocks. The pools and endpoints are listed in `src/pools.ts`.

Names are taken in this order, the first one winning: `labels.json` (yours), `signed-names.json` (proven by signature), then `pool-labels.json`. An unnamed address shows its coinbase tag if it writes one, or "Unnamed pool" if it pays its coinbases out to ten or more addresses at once.

A pool can prove an address is its own by signing a short text with it, with Oyster's `signmessage` or pearljs. This prints the text to sign:

```bash
node --no-warnings=ExperimentalWarning dist/cli.js proof-message Example Pool
```

Put the result in `signed-names.json`; entries whose signature does not verify are ignored and logged by the server:

```json
{ "names": [ { "pool": "Example Pool", "address": "prl1p...", "signature": "<base64>" } ] }
```

All these files are reread when they change.

`labels.json` groups payout addresses under a name. Every entry needs a source; leave an address unlabelled rather than guess:

```json
{ "identities": [ { "label": "Example pool", "scripts": ["prl1p..."], "source": "the pool's own payout page, 2026-11-18", "note": "optional" } ] }
```

`claims.json` holds what a pool or stats site says, next to what `pools` writes in `pool-claims.json`. Give a share, or a hashrate together with the network hashrate from the same page, since pools and stats sites do not use pearld's units:

```json
{ "claims": [ { "label": "Example pool", "hashrate": 43.9, "networkHashrate": 91.9, "readAt": 1795046400, "source": "miningboard.com" } ] }
```

## Pages and API

- `/` headline numbers, the top ten miners, hashrate and block-time charts, latest blocks. `?window=day|week|month|all` picks the last 445, 3,118 or 13,361 blocks, or all of them.
- `/miners` every miner, with a ranking chart of shares, their likely ranges and what pools say.
- `/miner/<id>` one miner: its numbers, what the pool says against what it found, its addresses and coinbase text, and transactions that link it to other addresses.
- `/blocks` every block, newest first.

- `/api/network.json`, `/api/miners.json`, `/api/blocks.json`, `/api/stale.json`.

In the miners table, "Pool claims" is the share a pool publishes about itself, and the column only appears when a miner in view has one. "matches" means the claim is inside the 95% range of what the pool's blocks show; "too high" or "too low" means it is outside, which normal luck produces less than 5 times in 100. A claim is only tested against blocks up to a day after it was read. Hovering a share or hashrate shows its range.

## What it can and cannot tell you

The question it started from was why a pool does not publish its measured hashrate or its effort per block. Those two numbers come from the shares miners send a pool, and shares never reach the chain, so only the pool can publish them. This dashboard cannot.

What it answers from public data alone:

- Who was paid for each block, and each address's or labelled pool's share of the last day, week or month of blocks, with an exact 95% interval.
- An estimated hashrate per miner and for the network, in pearld's units (the same as `getnetworkhashps`), with an interval.
- Whether a pool's published share or hashrate is consistent with the blocks its labelled addresses found, as a probability.
- Network effort and block times against the 194-second target, difficulty, empty blocks, fees claimed over the subsidy, certificate versions, and stale blocks this node saw.
- Addresses whose coinbase outputs were spent together, or paid out to many addresses, as evidence for grouping them.

What it cannot answer: a pool's own share-based hashrate and effort, which addresses belong to which pool unless someone with a source says so, and stale blocks this node never heard of.

## Tests

```bash
npm test
```

27 tests run against `pearljs/testing`'s simulated chain: the statistics against values from scipy, the indexer through reorganisations while running and while stopped, pearljs's block checks, coinbase co-spends, pool naming from feeds, trackers and spending, coinbase tags taken from mainnet blocks, signed names, claims, and the pages. One more runs against a real regtest pearld fed saved blocks:

```bash
PEARLD=../.work/regtest/bin/pearld PEARL_CHAIN=../.work/regtest/chain/setup-blocks.json npx vitest run --config vitest.live.config.ts
```

## Limits

- The simulated chain never changes difficulty, so the demo's difficulty figures do not move.
- An identity is the address of the largest coinbase output. A pool that pays every miner straight from the coinbase shows as its largest payee, and a pool that rotates addresses shows as several miners until a pool feed, a tracker or a co-spend names them.
- Solo pools' blocks pay the miner who found them; those addresses are named "<pool> Solo", not as the pool.
- Testnet stops at height 67370, where certificates move to V4, until pearljs parses them. See `PEARLJS-GAPS.md`.
- Mainnet: first run 2026-11-18 against pearld 1.5.7. A full sync from genesis took hours, mostly pearld fetching certificate-bearing headers from one peer at a time.
