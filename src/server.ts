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
import { loadClaims, loadLabels, type Claim, type Labels } from './labels.js';
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
  const labels = watched<Labels>(join(opts.dataDir, 'labels.json'), () => loadLabels(join(opts.dataDir, 'labels.json'), opts.network));
  const claims = watched<Claim[]>(join(opts.dataDir, 'claims.json'), () => loadClaims(join(opts.dataDir, 'claims.json')));
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const cache = new Map<string, string>();
  let cacheTip = '';
  let nodeHeight: number | null = null;
  let nodeCheckedAt = 0;

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
      const key = `${tip}|${url.pathname}${url.search}`;
      if (tip !== cacheTip) {
        cache.clear();
        cacheTip = tip;
      }
      const w = url.searchParams.get('window') ?? 'week';
      const window: WindowName = w in WINDOWS ? (w as WindowName) : 'week';
      const send = (status: number, type: string, body: string): void => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
        res.end(body);
      };
      const page = (make: () => string | null): void => {
        // Labels and claims can change without a new block; their state is part of the key.
        const k = `${key}|${ctx.labels.entries.length}|${ctx.claims.length}`;
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
      if (url.pathname === '/miners') return page(() => minersPage(ctx, window));
      if (url.pathname.startsWith('/miner/')) return page(() => minerPage(ctx, decodeURIComponent(url.pathname.slice(7)), window));
      if (url.pathname === '/api/network.json') return send(200, 'application/json', json(network(ctx, window)));
      if (url.pathname === '/api/miners.json') return send(200, 'application/json', json({ window, blocks: network(ctx, window)?.blocks ?? 0, miners: miners(ctx, window) }));
      if (url.pathname === '/api/blocks.json') return send(200, 'application/json', json(recentBlocks(ctx, Math.min(1000, Number(url.searchParams.get('limit') ?? 100)))));
      if (url.pathname === '/api/stale.json') return send(200, 'application/json', json(stale(ctx)));
      send(404, 'text/plain; charset=utf-8', 'Not found');
    })().catch((err: unknown) => {
      opts.log?.(`[serve] ${req.url}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Server error');
    });
  });
}

export function serve(opts: ServeOptions): Promise<Server> {
  const server = createApp(opts);
  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      opts.log?.(`[serve] http://${opts.host}:${opts.port}`);
      resolve(server);
    });
  });
}
