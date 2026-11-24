// A fetch that keeps under a public node's rate limit. pearlchain.live gives
// each address a bucket of 240 tokens refilled at 2 a second, and charges
// each method a set number of tokens; this spends from a bucket of its own,
// a little slower, so requests wait here instead of coming back as 429s.

// What pearlchain.live/rpc charges; anything not listed costs 1.
const COST: Record<string, number> = {
  getblock: 3,
  getrawtransaction: 2,
  getrawmempool: 2,
  getchaintips: 2,
  decoderawtransaction: 2,
  searchrawtransactions: 5,
  sendrawtransaction: 10,
};

interface Call {
  method?: unknown;
  params?: unknown;
}

/** Tokens a JSON-RPC body costs: getblock with full transactions (verbosity 2) is charged three times over. */
export function costOf(body: unknown): number {
  if (typeof body !== 'string') return 1;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 1;
  }
  const calls = (Array.isArray(parsed) ? parsed : [parsed]) as Call[];
  let total = 0;
  for (const c of calls) {
    const method = typeof c.method === 'string' ? c.method : '';
    let cost = COST[method] ?? 1;
    if (method === 'getblock' && Array.isArray(c.params) && c.params[1] === 2) cost *= 3;
    total += cost;
  }
  return Math.max(1, total);
}

export interface PaceOptions {
  /** Tokens added a second. */
  rate: number;
  /** Most tokens held at once. */
  burst: number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function pacedFetch(opts: PaceOptions): typeof globalThis.fetch {
  const inner = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let tokens = opts.burst;
  let at = now();
  // Requests take their tokens in the order they were made.
  let queue: Promise<void> = Promise.resolve();
  const take = (cost: number): Promise<void> => {
    const turn = queue.then(async () => {
      for (;;) {
        const t = now();
        tokens = Math.min(opts.burst, tokens + ((t - at) / 1000) * opts.rate);
        at = t;
        if (tokens >= cost) {
          tokens -= cost;
          return;
        }
        await sleep(Math.ceil(((cost - tokens) / opts.rate) * 1000));
      }
    });
    queue = turn;
    return turn;
  };
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    await take(costOf(init?.body));
    return inner(input, init);
  }) as typeof globalThis.fetch;
}
