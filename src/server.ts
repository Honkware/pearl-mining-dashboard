// A small HTTP server: HTML pages, a JSON API, the stylesheet and the fonts.
// Pages are cached per tip hash, so each is computed once per block; labels
// and claims are reread when their files change.
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PearlNetwork } from 'pearljs';
import { WINDOWS, miners, network, recentBlocks, stale, type WindowName } from './analysis.js';
import type { Store } from './db.js';
import { loadClaims, loadLabels, loadSignedNames, mergeLabels, type Claim, type Labels } from './labels.js';
import { blocksPage, minerPage, minersPage, overview, type PageCtx } from './views.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const font = (pkg: string, file: string): string => join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file);
const STATIC: Record<string, { path: string; type: string }> = {
  '/static/app.css': { path: join(root, 'static', 'app.css'), type: 'text/css; charset=utf-8' },
  '/fonts/next-400.woff2': { path: font('@fontsource/atkinson-hyperlegible-next', 'atkinson-hyperlegible-next-latin-400-normal.woff2'), type: 'font/woff2' },
  '/fonts/next-600.woff2': { path: font('@fontsource/atkinson-hyperlegible-next', 'atkinson-hyperlegible-next-latin-600-normal.woff2'), type: 'font/woff2' },
  '/fonts/next-700.woff2': { path: font('@fontsource/atkinson-hyperlegible-next', 'atkinson-hyperlegible-next-latin-700-normal.woff2'), type: 'font/woff2' },
  '/fonts/mono-400.woff2': { path: font('@fontsource/atkinson-hyperlegible-mono', 'atkinson-hyperlegible-mono-latin-400-normal.woff2'), type: 'font/woff2' },
};

export interface ServeOptions {
  store: Store;
  network: PearlNetwork;
  /** Where labels.json and claims.json are read from. */
  dataDir: string;
  port: number;
  host: string;
  /** Height pearld reports, to show how far behind the index is. */
  nodeHeight?: () => Promise<number | null>;
  now?: () => number;
  log?: (line: string) => void;
}

function watched<T>(path: string, load: () => T): () => T {
  let mtime = -1;
  let value: T;
  return () => {
    let m = 0;
    try {
      m = statSync(path).mtimeMs;
    } catch {
      m = 0;
    }
    if (m !== mtime) {
      value = load();
      mtime = m;
    }
    return value;
  };
}

const json = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 1);

export function createApp(opts: ServeOptions): Server {
  const file = (name: string): string => join(opts.dataDir, name);
  const handLabels = watched<Labels>(file('labels.json'), () => loadLabels(file('labels.json'), opts.network));
  const poolLabels = watched<Labels>(file('pool-labels.json'), () => loadLabels(file('pool-labels.json'), opts.network));
  const handClaims = watched<Claim[]>(file('claims.json'), () => loadClaims(file('claims.json')));
  const poolClaims = watched<Claim[]>(file('pool-claims.json'), () => loadClaims(file('pool-claims.json')));
  const signedNames = watched<Labels>(file('signed-names.json'), () => {
    const { labels: l, rejected } = loadSignedNames(file('signed-names.json'), opts.network);
    for (const r of rejected) opts.log?.(`[serve] signed-names.json: signature does not verify for ${r.pool} ${r.address}`);
    return l;
  });
  // Your own labels first, then names proven by signature, then what pools and trackers publish.
  const labels = (): Labels => mergeLabels(handLabels(), signedNames(), poolLabels());
  const claims = (): Claim[] => [...handClaims(), ...poolClaims()];
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = new Map<string, string>();
  let cacheTip = '';
  let cacheAt = 0;
  let nodeHeight: number | null = null;
  let nodeCheckedAt = 0;

  // Labels and claims can change without a new block; their state is part of the key.
  const cacheKey = (path: string, ctx: PageCtx): string =>
    `${path}|${ctx.labels.byScript.size}|${ctx.labels.entries.length}|${ctx.claims.map((c) => c.readAt).join(',')}`;

  // Renders the overview for every window after new blocks, one per turn of the
  // event loop, so switching windows finds the page ready; "all" alone takes seconds.
  const warm = (ctx: PageCtx): void => {
    const tip = cacheTip;
    const paths = (Object.keys(WINDOWS) as WindowName[]).map((w) => [`/?window=${w}`, w] as const);
    const next = (i: number): void => {
      if (i >= paths.length || cacheTip !== tip) return;
      const [path, w] = paths[i]!;
      if (!cache.has(cacheKey(path, ctx))) cache.set(cacheKey(path, ctx), overview(ctx, w));
      setImmediate(() => next(i + 1));
    };
    setImmediate(() => next(0));
  };

  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const asset = STATIC[url.pathname];
      if (asset !== undefined) {
        // Fonts never change; the stylesheet does between releases.
        res.writeHead(200, { 'content-type': asset.type, 'cache-control': asset.type === 'font/woff2' ? 'public, max-age=86400' : 'no-cache' });
        res.end(readFileSync(asset.path));
        return;
      }
      if (opts.nodeHeight !== undefined && now() - nodeCheckedAt > 30) {
        nodeCheckedAt = now();
        nodeHeight = await opts.nodeHeight().catch(() => null);
      }
      const ctx: PageCtx = { store: opts.store, network: opts.network, labels: labels(), claims: claims(), now: now(), nodeHeight };
      const tip = recentBlocks(ctx, 1)[0]?.hash ?? '';
      const key = `${url.pathname}${url.search}`;
      // A new block clears the pages, but no more than every 15 s: while the
      // indexer catches up, blocks arrive many times a second.
      if (tip !== cacheTip && now() - cacheAt >= 15) {
        cache.clear();
        cacheTip = tip;
        cacheAt = now();
        warm(ctx);
      }
      const w = url.searchParams.get('window') ?? 'week';
      const window: WindowName = w in WINDOWS ? (w as WindowName) : 'week';
      const send = (status: number, type: string, body: string): void => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
      };
      const page = (make: () => string | null): void => {
        const k = cacheKey(key, ctx);
        let html = cache.get(k) ?? null;
        if (html === null) {
          html = make();
          if (html !== null) cache.set(k, html);
        }
        if (html === null) send(404, 'text/plain; charset=utf-8', 'Not found');
        else send(200, 'text/html; charset=utf-8', html);
      };

      if (url.pathname === '/') return page(() => overview(ctx, window));
      if (url.pathname === '/blocks') {
        const below = url.searchParams.get('below');
        return page(() => blocksPage(ctx, below === null ? null : Number(below)));
      }
      if (url.pathname === '/miners') return page(() => minersPage(ctx, window, url.searchParams.get('q') ?? '', Number(url.searchParams.get('page') ?? 1) || 1));
      if (url.pathname.startsWith('/miner/')) return page(() => minerPage(ctx, decodeURIComponent(url.pathname.slice(7)), window));
      if (url.pathname === '/api/network.json') return send(200, 'application/json', json(network(ctx, window)));
      if (url.pathname === '/api/miners.json') return send(200, 'application/json', json({ window, blocks: network(ctx, window)?.blocks ?? 0, miners: miners(ctx, window) }));
      if (url.pathname === '/api/blocks.json') return send(200, 'application/json', json(recentBlocks(ctx, Math.min(1000, Number(url.searchParams.get('limit') ?? 100)))));
      if (url.pathname === '/api/tip.json') return send(200, 'application/json', json(recentBlocks(ctx, 1)[0] ?? {}));
      if (url.pathname === '/api/stale.json') return send(200, 'application/json', json(stale(ctx)));
      send(404, 'text/plain; charset=utf-8', 'Not found');
    })().catch((err: unknown) => {
      opts.log?.(`[serve] ${req.url}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    });
  });
}

export function serve(opts: ServeOptions & { refreshPools?: boolean }): Promise<Server> {
  const server = createApp(opts);
  if (opts.refreshPools === true) {
    // Pool feeds only cover recent blocks and claims age; re-read them every hour.
    // The labels and claims files are watched, so the pages pick the result up.
    const run = async (): Promise<void> => {
      try {
        const { collectPools, writePools } = await import('./pools.js');
        const result = await collectPools({ store: opts.store, network: opts.network, dataDir: opts.dataDir, now: Math.floor(Date.now() / 1000) });
        writePools(opts.dataDir, result);
        const failed = result.results.filter((r) => r.error !== undefined).map((r) => r.label);
        opts.log?.(`[pools] refreshed ${result.labels.length} names, ${result.claims.length} claims${failed.length ? `; failed: ${failed.join(', ')}` : ''}`);
      } catch (err) {
        opts.log?.(`[pools] refresh failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    setInterval(() => void run(), 3_600_000).unref();
  }
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      opts.log?.(`[serve] http://${opts.host}:${opts.port}`);
      resolve(server);
    });
  });
}
