# Plan

A dashboard that says, from public chain data alone, who mines Pearl blocks, how much of the network each payout identity appears to have, and how lucky each one has been, with every number labelled as measured, estimated (with its interval) or claimed.

## What the chain proves

Read from `.work/pearl-clean` at 38dd764a.

Per block, from the block itself:

- Height, hash, timestamp, bits, and from those the difficulty and the work (`CalcWork`, 2^256 / (target + 1)). Pearl retargets every block with WTEMA, so each block has its own expected work.
- The certificate version (V1 to V3 on mainnet, V4/FP8 on testnet after 67370) and kind (dense or MoE). pearljs parses V1 to V3 only today.
- The coinbase: its payout outputs and their scripts, the BIP 34 height, and any bytes the miner appended. pearld's own template code (`node/mining/mining.go`) writes height, extra nonce and `/P2SH/pearld/`, and the reference gateway (`miner/pearl-gateway`) writes height, a zero byte and the same flag, with one P2TR output for the whole value. So most blocks carry no pool tag; a pool that adds one is making a claim about itself, which anyone can copy.
- Fees: the coinbase reward minus the subsidy is what the miner claimed in fees. This needs no `--txindex`. Exact fees need every prevout, which the indexer can get only with `--txindex`; the dashboard shows the claimed figure and says so.
- Transaction count and vsize, so empty blocks (coinbase only) are a measured fact per identity.

Across blocks:

- Intervals between consecutive timestamps against the 194 s target. Timestamps are set by miners and may go backwards, so a single interval is weak evidence and only windows are shown.
- Network work rate, as pearld's `getnetworkhashps` computes it: summed work over the time span of a window. Its unit is "hashes" in pearld's sense, one PoW lottery ticket (a blake3 hash of a matmul transcript checked against the target in `miner-base/noisy_gemm.py`). Pools quote "hashrate" in units of their own share difficulty, which is why public figures differ by orders of magnitude (a pool page shows 41.73 EH/s while an aggregator lists 8.35 PH/s for the largest pool it tracks). The dashboard never compares a pool's number with the chain's without stating the unit.
- Spending of coinbase outputs, which the indexer sees as it follows every block. A coinbase output later spent in a transaction with many outputs looks like a pool paying its miners; coinbase outputs of different scripts spent together in one transaction were probably controlled by one party. Both are shown as evidence for a human to act on in the labels file, never merged automatically.
- Stale blocks, only when this node saw them: a `disconnected` event from the follower and side branches in `getchaintips`. A dashboard that starts late or runs on a node with few peers misses most of them, so the count is a lower bound for "what this node saw".

## What the chain cannot say

A pool's measured hashrate and its per-block effort come from its share database (shares submitted against the pool's share target between two blocks). None of that is on chain. What the chain allows:

- An estimated share of network hashrate for each payout identity: k of n blocks in a window, with a Clopper-Pearson 95% interval on k/n. Multiplied by the network work rate it becomes an estimated hashrate in pearld's units, with the same relative interval.
- Network effort per block: the actual interval over 194 s, and over a window the sum of intervals over the expected time. On a per-identity basis the matching quantity is luck: blocks found against blocks expected from a stated hashrate.
- A test of a published claim: if a pool says it had share s over a window of n blocks, the probability of it finding k or fewer (or k or more) is a binomial tail. That is the honest check on "we found fewer blocks than expected, it was bad luck".

Public pools seen in a quick search: Kryptex (`pool.kryptex.com/prl`, shows pool hashrate and an effort column per block), PearlNet (`pearl-net.com`, has an API link), Alphapool (`pearl.alphapool.tech`), suprnova (`prl.suprnova.cc`) and aggregators such as miningboard.com. None of their API schemas were verified. The dashboard takes pool claims only from a hand-edited `claims.json` (pool, window, claimed hashrate or share, source URL, date read) and shows them as "claimed by <source>", next to the chain's estimate. It fetches nothing from pools on its own.

## What the Bitcoin side already shows

Read on 2026-11-18 from the code of the open-source ones and the public pages of the rest.

- mempool.space (Angular, Bootstrap, ECharts; dark navy `#11131f` with `#171c2a` cards, system fonts): pool ranking by blocks over 24h to all time, a pie of shares, per-pool hashrate computed in `backend/src/api/mining/mining.ts` as `getnetworkhashps` times the pool's share of blocks, with no interval; empty blocks and their ratio; "block health", the match between a mined block and the node's own template; average fee delta against that template; a pool page with its coinbase tags and known addresses and blocks in 24h, 1w and all. "Pools luck" is the week's average block time against 10 minutes.
- miningpool-observer by 0xB10C (Rust, Tera templates, Bootstrap light, d3): compares every block with the node's own templates and lists missing and extra transactions per pool. Its FAQ explains each method and says where it is biased in the pools' favour. Pool identification comes from the known-mining-pools list of coinbase tags and addresses, which it calls unauthenticated.
- mainnet-observer by 0xB10C (Hugo static site, Bootstrap, ECharts): a gallery of daily charts, including a Mining Centralization Index (summed share of the top 2 to 6 pools) and an "AntPool and friends" series for pools believed to be proxies of one another.
- OCEAN: publishes its share log window, shares against network difficulty for each block it found (the raw material of effort), and contributors with their share of the pool. That is what a pool can show that the chain cannot.
- miningpoolstats.stream (AdminLTE template): pool table with "Blocks in last 100" and fees, and labels pool figures "reported by pools".
- For Pearl: Kryptex (Nuxt/Vue by its asset paths) shows pool hashrate (43.92 EH/s when read) and an Effort column per block with no definition; miningboard.com shows network hashrate 91.95 EH/s, 56 pools, Kryptex at 47.8% share, and height 145,233; PearlNet refused the fetch. None of them shows an interval or says how a figure was derived.

So people already expect a pool table over several windows, hashrate and difficulty history, empty blocks, and a page per pool with its tags and addresses. What none of them does, and what this dashboard adds: an interval on every estimated share, a test of each pool's claim against blocks on chain, a definition beside every number, and a centralization view with its uncertainty. Template comparison (block health) needs a node answering `getblocktemplate` for the full RPC user and is left for a second version.

## Look

Two mockups were rejected (a printed-report look, then a copy of mempool.space's card grid with tracked uppercase labels), and a text-heavy third version as too dense. The built pages take the parts of each real site that work: mempool.space's headline row, window buttons and latest-blocks list; MiningBoard's pool table with share bars and last-block ages; the per-block effort column of p2pool.observer and Kryptex; OCEAN's window buttons. Intervals are a whisker on each share bar, claims a diamond on the same bar, and definitions sit in tooltips. A later polish replaced percentages over 100% (effort) with times and block counts, put claim checks in words, and dropped the method page. One typeface, Atkinson Hyperlegible Next (tabular figures and a slashed zero, checked in the font file), with its Mono for addresses; colours from three OKLCH inputs, dark by default with a light theme. Charts are server-drawn SVG. The research behind this is in `../reports/Pearl mining dashboard research.md`.

## Data source

Mainnet is the target. pearld can be built from `.work/pearl-clean` as the regtest binaries were. Mainnet RPC listens on 44107, peers come from `reef`, `tide` and `stream.seeder.pearlnetwork.net`. The follower needs only `getbestblock`, `getblockhash` and `getblock`, so the limited RPC user is enough and no index is required. `--txindex` adds exact fees; `--metricslisten=127.0.0.1:9105` adds pearld's own reorg and orphan counters, which the dashboard can show as "this node's counters". Nothing connects to mainnet and no long-running node starts without asking first. Development uses `pearljs/testing`'s `SimulatedChain` (miners chosen per block with `coinbaseTo`, time moved with `advanceTime`) and a regtest pearld fed the 101 cached blocks in `.work/regtest/chain/setup-blocks.json` with `submitblock`.

## Build

TypeScript on Node 22, `pearljs` as a `file:../pearljs` dependency, `node:sqlite` for storage (built in, no native module), a plain `node:http` server rendering HTML with inline SVG charts, and a JSON API under `/api`. No frontend framework.

1. Indexer: `watchChain` from a stored cursor; each event and the cursor are written in one SQLite transaction. Tables: `blocks` (header facts, certificate, coinbase reward, subsidy, tx count, vsize, primary payout script), `payouts` (every coinbase output), `coinbase_spends` (which transaction spent a coinbase output, its input and output counts, co-spent scripts), `stale` (blocks this node disconnected), `cursor`. A disconnect deletes the newest block's rows. A restart resumes from the cursor and replays any reorg that happened while it was down.
2. Attribution: an identity is the script of the largest non-OP_RETURN coinbase output, unless `labels.json` groups several scripts under one label. Coinbase tags are shown as the miner's own text. Suggested links (co-spent coinbase outputs, fan-out payouts) appear on the miner page as evidence.
3. Statistics: pure functions with unit tests (Clopper-Pearson, Poisson and binomial tails, effort, work rate), checked against values computed independently.
4. Web: home (network work rate and difficulty over time, block intervals and effort, miners table with share of blocks over 24 h, 7 d and 30 d and intervals), a page per identity (blocks, payouts, luck against any claim, linked scripts, empty blocks), a stale-blocks page. Each figure carries a small tag: measured, estimated, or claimed.
5. Tests on the simulated chain (several miners, reorgs while running and while stopped, restarts), one regtest test against a real pearld, and a README with exact commands for a real node.

Gaps in pearljs go in `PEARLJS-GAPS.md`; already known: certificate version 4 (FP8) is not parsed, so a testnet follower stops at 67370.
