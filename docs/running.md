# Running it against a real node

## The public node

With `PEARLD_URL` unset, the indexer and server use pearlchain.live's public mainnet node at https://pearlchain.live/rpc, set up as pearljs's "Choosing a backend" guide shows. It needs no login. It gives each address 240 tokens refilled at 2 a second, and a block costs the indexer 4 (`getblockhash` and `getblock`), so `src/pace.ts` spends at 1.8 a second: about 27 blocks a minute once the first burst is used. Its websocket feed is its own format, not pearld's, so the indexer polls for new blocks.

Start an empty store a number of blocks below the tip with `START_BLOCKS`; 13361 is the dashboard's month:

```bash
START_BLOCKS=13361 node --no-warnings=ExperimentalWarning dist/cli.js index
```

`INDEX_MINUTES` stops a run after that many minutes; the next run resumes from the stored cursor. The empty-block check compares each block with the mempool seen just before it, so it needs the indexer running at the tip without breaks.

## A node of your own

Use a pearld release binary, or build it from Pearl's source (github.com/pearl-research-labs/pearl), which needs its zk-pow Rust bindings built first; its Taskfile has the steps. Give it a limited RPC user in `pearld.conf` in its home directory, so the passwords stay off the command line:

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

A full mainnet node downloads the whole chain from peers found through Pearl's DNS seeds. On 2026-11-18, pearld 1.5.7 took 173 minutes to sync from genesis to block 145,331, mostly fetching certificate-bearing headers from one peer at a time.

## Indexer

```bash
export PEARL_NETWORK=mainnet PEARLD_URL=https://127.0.0.1:44107 PEARLD_USER=dashboard PEARLD_PASS=... PEARLD_CERT="$HOME/Library/Application Support/Pearld/rpc.cert"
```

```bash
node --no-warnings=ExperimentalWarning dist/cli.js index
```

It starts at genesis (or `START_HEIGHT`), logs every 1000th block, waits at the tip for new blocks (woken by pearld's websocket, with a poll as backup), and resumes from its stored cursor after a restart. Each block goes through pearljs's block checks; a failure is logged as `[index] block N <hash> failed <check>` and stored with the block. `STOP_AT_TIP=1` makes it exit at the tip instead. Data goes to `data/mainnet.sqlite` (`DATA_DIR` to change it).

## Web server

In a second shell with the same environment:

```bash
node --no-warnings=ExperimentalWarning dist/cli.js serve
```

It listens on 127.0.0.1:8080 (`HOST`, `PORT`) and shows a banner while the indexer is behind the node.

## Older payouts

The indexer records what each coinbase-spending transaction paid, and its other inputs, as it goes. The inputs are how a pool's change is told from a payment: an address a pool paid and later spent from, in another of its payout transactions, is the pool's own. A store made before either was recorded fills it in for past blocks with:

```bash
node --no-warnings=ExperimentalWarning dist/cli.js backfill
```

It reads only the blocks that hold such transactions, and can be stopped and run again. Until it has finished, pool pages show how many addresses a pool paid but not how much. Whether a block left transactions waiting is only known for blocks seen live.
