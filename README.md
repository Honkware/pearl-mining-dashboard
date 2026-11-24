# pearl-mining-dashboard

A dashboard of who mines Pearl blocks, read from your own pearld node. For each pool and payout address it shows its share of blocks with a 95% interval, an estimated hashrate, where its coinbase rewards went, and how often it mined empty blocks while transactions were waiting. It also tests what each pool says about its own size against the blocks it actually found.

Pool names come from what the pools publish about themselves (block lists, wallets and payout transactions), matched against the chain, with coinbase tags and the PearlStation and PearlTrack trackers filling gaps. A pool can also prove an address is its own by signing a message with it. The method behind each number, and what the chain cannot tell you, are in [docs/reference.md](docs/reference.md).

## Run the demo

The demo builds a seeded simulated chain of 3,600 blocks with made-up pools, indexes it and serves it, so it needs no node. It needs Node 22.13 or newer.

```bash
npm install
```

```bash
npm run build
```

```bash
node --no-warnings=ExperimentalWarning dist/cli.js demo
```

Then open http://127.0.0.1:8080.

## Run it on mainnet

Point the indexer at a pearld node with a limited RPC user, run the web server beside it, and run `pools` to name the pools. [docs/running.md](docs/running.md) has the pearld settings and commands, and [docs/pools.md](docs/pools.md) covers naming, claims and signed names.

## Made with pearljs

This is the first application built on [pearljs](https://github.com/Honkware/pearljs), the TypeScript SDK for Pearl. pearljs follows the chain through reorganisations, parses every block and its certificate, checks each block, reads the mempool, verifies signed messages, and provides the simulated chain every test runs on. The table in [docs/reference.md](docs/reference.md) shows which part does what, and [PEARLJS-GAPS.md](PEARLJS-GAPS.md) lists what it did not cover.

## Tests

```bash
npm test
```

The tests run against pearljs's simulated chain; one more runs against a real regtest pearld, described in [docs/reference.md](docs/reference.md).

## Related

[pearl-mineable](https://github.com/Honkware/pearl-mineable) is a sibling tool built on pearljs. It reads a model's `config.json` and works out how much of its prompt math mines Pearl, on which cards and for what earnings, in the browser and with no node.

## Licence

MIT. This project is independent of Pearl Research Labs and not endorsed by them.
