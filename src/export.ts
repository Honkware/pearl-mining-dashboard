// Writes the dashboard out as files for a static host such as GitHub Pages.
// It runs the same server on a free port and follows its links from the
// overview, so the files are exactly the pages the server would give. Links
// with a query become folders: /miners?window=day&page=2 is
// /miners/window/day/page/2/. Everything is put under `base`, the path the
// site is served from.
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { PearlNetwork } from 'pearljs';
import type { Store } from './db.js';
import { STATIC, createApp } from './server.js';

export interface ExportOptions {
  store: Store;
  network: PearlNetwork;
  dataDir: string;
  outDir: string;
  /** Path the site is served under, as "/pearl-mining-dashboard"; "" for the root. */
  base: string;
  nodeHeight?: number | null;
  /** Pages past this many are left out, and links to them lead to the 404 page. */
  maxPages?: number;
  log?: (line: string) => void;
}

// File and folder names keep to these characters; anything else is written as _xx.
const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9._:-]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);

/** Where a server URL lives in the static site, starting with "/". */
export function staticPath(url: string): string {
  const u = new URL(url, 'http://x');
  const segments = u.pathname.split('/').filter((s) => s !== '').map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  // Stylesheets, fonts and JSON keep their name; their query is only a cache buster.
  if (/\.[a-z0-9]+$/.test(u.pathname)) return `/${segments.map(safe).join('/')}`;
  const params = [...u.searchParams].sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of params) segments.push(k, v);
  return segments.length === 0 ? '/' : `/${segments.map(safe).join('/')}/`;
}

const unescape = (s: string): string => s.replace(/&amp;/g, '&');

export async function exportSite(opts: ExportOptions): Promise<number> {
  const base = opts.base.replace(/\/+$/, '');
  const maxPages = opts.maxPages ?? 20_000;
  const app = createApp({
    store: opts.store,
    network: opts.network,
    dataDir: opts.dataDir,
    port: 0,
    host: '127.0.0.1',
    nodeHeight: async () => opts.nodeHeight ?? null,
    staticSite: true,
    ...(opts.log === undefined ? {} : { log: opts.log }),
  });
  // Some pages take seconds to build; an idle connection closed meanwhile would fail the next request.
  app.keepAliveTimeout = 0;
  await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
  rmSync(opts.outDir, { recursive: true, force: true });
  const write = (path: string, body: string | Buffer): void => {
    const file = join(opts.outDir, path.endsWith('/') ? `${path}index.html` : path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  };
  try {
    for (const [path, asset] of Object.entries(STATIC)) {
      mkdirSync(dirname(join(opts.outDir, path)), { recursive: true });
      copyFileSync(asset.path, join(opts.outDir, path));
    }
    const seen = new Set<string>(['/']);
    const queue = ['/'];
    let pages = 0;
    while (queue.length > 0 && pages < maxPages) {
      const url = queue.shift()!;
      const res = await fetch(origin + url);
      if (res.status !== 200) {
        opts.log?.(`[export] ${url}: HTTP ${res.status}`);
        continue;
      }
      // Each internal link is queued and pointed at its file.
      const html = (await res.text()).replace(/(href|action)="(\/[^"/][^"]*|\/)"/g, (_m, attr: string, link: string) => {
        const target = unescape(link);
        if (!/\.[a-z0-9]+(\?|$)/.test(target) && !seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
        return `${attr}="${base}${staticPath(target)}"`;
      });
      write(staticPath(url), html.replace(/fetch\('\/api\/tip\.json'/g, `fetch('${base}/api/tip.json'`));
      pages += 1;
      if (pages % 1000 === 0) opts.log?.(`[export] ${pages} pages, ${queue.length} queued`);
    }
    if (queue.length > 0) opts.log?.(`[export] stopped at ${maxPages} pages; ${queue.length} left out`);
    for (const api of ['/api/tip.json', '/api/network.json', '/api/miners.json', '/api/blocks.json', '/api/stale.json']) {
      write(api, await (await fetch(origin + api)).text());
    }
    write('/404.html', `<!doctype html><meta charset="utf-8"><title>Not found</title><p>Not found. <a href="${base}/">Pearl mining</a></p>`);
    // Tells GitHub Pages to serve the folders as they are, including names that start with "_".
    write('/.nojekyll', '');
    return pages;
  } finally {
    app.closeAllConnections();
    await new Promise<void>((resolve) => app.close(() => resolve()));
  }
}
