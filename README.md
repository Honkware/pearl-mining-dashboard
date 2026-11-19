# pearl-mining-dashboard

Who mines Pearl blocks, read from a pearld node: each payout address's share of blocks with a 95% interval, an estimated hashrate in pearld's units, network hashrate, difficulty, block times and effort, and a check of what pools claim against the blocks they actually found.

It is a TypeScript server with two parts. The indexer follows the node's best chain with `pearljs`'s `followChain`, survives reorganisations and restarts, and keeps one row per block in SQLite. The web server renders the pages from that database, with a small JSON API. Nothing is fetched from pools or third parties: pool claims are typed into `claims.json` by hand, with their source and date.

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

It starts at genesis (or `START_HEIGHT`), logs every 1000th block, waits at the tip for new blocks, and resumes from its stored cursor after a restart. `STOP_AT_TIP=1` makes it exit at the tip instead. Data goes to `data/mainnet.sqlite` (`DATA_DIR` to change it).

### 3. Web server

In a second shell with the same environment:

```bash
node --no-warnings=ExperimentalWarning dist/cli.js serve
```

It listens on 127.0.0.1:8080 (`HOST`, `PORT`) and shows a banner while the indexer is behind the node.

### Labels and claims

Both files live in `DATA_DIR` and are reread when they change.

`labels.json` groups payout addresses under a name. Every entry needs a source; leave an address unlabelled rather than guess:

```json
{ "identities": [ { "label": "Example pool", "scripts": ["prl1p..."], "source": "the pool's own payout page, 2026-11-18", "note": "optional" } ] }
```

`claims.json` holds what a pool or stats site says. Give a share, or a hashrate together with the network hashrate from the same page, since pools and stats sites do not use pearld's units:

```json
{ "claims": [ { "label": "Example pool", "hashrate": 43.9, "networkHashrate": 91.9, "readAt": 1795046400, "source": "miningboard.com" } ] }
```

## Pages and API

- `/` headline numbers, the top ten miners, hashrate and block-time charts, latest blocks. `?window=day|week|month|all` picks the last 445, 3,118 or 13,361 blocks, or all of them.
- `/miners` every miner, with a ranking chart of shares, their likely ranges and what pools say.
- `/miner/<id>` one miner: its numbers, what the pool says against what it found in plain words, its addresses and coinbase text, and transactions that link it to other addresses.
- `/blocks` every block, newest first.

In the miners table, "Pool says" is the share a pool publishes about itself, from `claims.json`. "matches" means the claim is inside the 95% range of what the pool's blocks show; "too high" or "too low" means it is outside, which normal luck produces less than 5 times in 100. Hovering a number shows its range and how it was worked out.
- `/api/network.json`, `/api/miners.json`, `/api/blocks.json`, `/api/stale.json`.

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

20 tests run against `pearljs/testing`'s simulated chain: the statistics against values from scipy, the indexer through reorganisations while running and while stopped, coinbase co-spends, claims, and the pages. One more runs against a real regtest pearld fed saved blocks:

```bash
PEARLD=../.work/regtest/bin/pearld PEARL_CHAIN=../.work/regtest/chain/setup-blocks.json npx vitest run --config vitest.live.config.ts
```

## Limits

- The simulated chain never changes difficulty, so the demo's difficulty chart is flat.
- An identity is the address of the largest coinbase output. A pool that pays every miner straight from the coinbase shows as its largest payee, and a pool that rotates addresses shows as several miners until they are labelled.
- Testnet stops at height 67370, where certificates move to V4, until pearljs parses them. See `PEARLJS-GAPS.md`.
- Nothing has been run against mainnet yet.
