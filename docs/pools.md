# Pool names and claims

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

On the pages, "Pool claims" is the share a pool publishes about itself, and the column only appears when a miner in view has one. "matches" means the claim is inside the 95% range of what the pool's blocks show; "too high" or "too low" means it is outside, which normal luck produces less than 5 times in 100. A claim describes the pool now, so it is only tested on the 1D and 1W windows.
