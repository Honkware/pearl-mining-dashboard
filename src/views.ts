// HTML pages. The overview is for a glance: headline numbers, the miners,
// the latest blocks. Definitions live in tooltips.
import {
  WINDOWS,
  intervals,
  links,
  miners,
  network,
  recentBlocks,
  series,
  shareHistory,
  type Context,
  type MinerRow,
  type Network,
  type RecentBlock,
  type WindowName,
} from './analysis.js';
import { esc, intervalHistogram, lineChart, pct, rankChart, shareBar, sparkline } from './charts.js';

const GRAIN = 100_000_000n;
const int = (n: number): string => n.toLocaleString('en-US');

export function prl(grain: bigint, digits = 2): string {
  const frac = Number(grain % GRAIN) / 1e8;
  return `${int(Number(grain / GRAIN))}${frac.toFixed(digits).slice(1)}`;
}

/** Work per second in pearld's units, with an SI prefix. */
export function rate(v: number): string {
  const prefixes = ['', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
  let i = 0;
  while (v >= 1000 && i < prefixes.length - 1) {
    v /= 1000;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${prefixes[i]}H/s`;
}

function bigNum(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} G`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(2)} k`;
  return v.toFixed(v < 10 ? 3 : 1);
}

function ago(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86_400)}d`;
}

const utc = (t: number): string => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
export const minerHref = (id: string): string => `/miner/${encodeURIComponent(id)}`;
// Where "Made with pearljs" links to, once pearljs has a public home.
const PEARLJS_URL = process.env.PEARLJS_URL ?? '';

// Changes on every start, so browsers never reuse a stylesheet from an older build.
const STYLE_VERSION = Date.now().toString(36);
const WINDOW_SHORT: Record<WindowName, string> = { day: '1D', week: '1W', month: '1M', all: 'All' };

export interface PageCtx extends Context {
  now: number;
  /** Height pearld reports, to say how far behind the index is. */
  nodeHeight?: number | null;
}

/** What a miner is called on the page: its label, its coinbase tag, "Unnamed pool", or its address. */
function minerTitle(r: Pick<MinerRow, 'name' | 'labelled' | 'tags' | 'paysOut'>): { text: string; mono: boolean } {
  if (r.labelled) return { text: r.name, mono: false };
  // "/F2Pool/" reads as "F2Pool"; the slashes are only how coinbase tags are written.
  if (r.tags.length > 0) return { text: r.tags[0]!.replace(/^\/+|\/+$/g, '').replace(/\//g, ' / '), mono: false };
  if (r.paysOut) return { text: 'Unnamed pool', mono: false };
  return { text: short(r.name), mono: true };
}

function short(name: string): string {
  return name.length > 22 ? `${name.slice(0, 10)}…${name.slice(-6)}` : name;
}

function titleLink(r: MinerRow): string {
  const t = minerTitle(r);
  return `<a class="who${t.mono ? ' mono' : ''}" href="${minerHref(r.id)}" title="${esc(r.name)}">${esc(t.text)}</a>`;
}

function minerLink(id: string, name: string, labelled = id.startsWith('label:')): string {
  return labelled
    ? `<a class="who" href="${minerHref(id)}">${esc(name)}</a>`
    : `<a class="who mono" href="${minerHref(id)}" title="${esc(name)}">${esc(short(name))}</a>`;
}

function layout(ctx: PageCtx, title: string, current: string, body: string): string {
  const tip = recentBlocks(ctx, 1)[0];
  const nav = [['/', 'Overview'], ['/miners', 'Miners'], ['/blocks', 'Blocks']]
    .map(([href, text]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${text}</a>`)
    .join('');
  let notice = '';
  if (tip !== undefined && ctx.nodeHeight != null && ctx.nodeHeight - tip.height > 3) {
    notice = `<div class="notice">Syncing: block ${int(tip.height)} of ${int(ctx.nodeHeight)}</div>`;
  } else if (tip !== undefined && ctx.now - tip.time > 3600) {
    notice = `<div class="notice">Syncing: up to ${new Date(tip.time * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</div>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/static/app.css?v=${STYLE_VERSION}">
<script>try{const t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch{}</script>
</head>
<body data-tip="${tip?.hash ?? ''}">
<header class="bar"><div class="wrap">
  <a class="brand" href="/">Pearl mining</a>
  <nav>${nav}</nav>
  <span class="status">${tip === undefined ? 'No blocks yet' : `<span class="live"></span>${esc(ctx.network.name)} <b>${int(tip.height)}</b> ${ago(ctx.now - tip.time)} ago`}</span>
  <button type="button" id="theme" title="Light or dark">◐</button>
</div></header>
<main class="wrap">
${notice}
${body}
</main>
<footer class="wrap">Made with ${PEARLJS_URL ? `<a href="${esc(PEARLJS_URL)}">pearljs</a>` : 'pearljs'}</footer>
<script>
// Chart hover: moves the chart's cursor to the nearest point and shows its values.
const tip=document.createElement('div');tip.className='tip';tip.hidden=true;document.body.append(tip);const pts=new WeakMap();
const hide=()=>{tip.hidden=true;document.querySelectorAll('svg[data-hover] .cursor,svg[data-hover] .cursor-dot').forEach(e=>e.setAttribute('visibility','hidden'))};
document.addEventListener('pointermove',e=>{const svg=e.target.closest&&e.target.closest('svg[data-hover]');if(!svg){hide();return}let p=pts.get(svg);if(!p){p=JSON.parse(svg.dataset.hover);pts.set(svg,p)}const m=svg.getScreenCTM();if(!m)return;const at=new DOMPoint(e.clientX,e.clientY).matrixTransform(m.inverse());let best=p[0];for(const q of p)if(Math.abs(q[0]-at.x)<Math.abs(best[0]-at.x))best=q;const c=svg.querySelector('.cursor'),d=svg.querySelector('.cursor-dot');c.setAttribute('x1',best[0]);c.setAttribute('x2',best[0]);c.setAttribute('visibility','visible');d.setAttribute('cx',best[0]);d.setAttribute('cy',best[1]);d.setAttribute('visibility','visible');tip.replaceChildren(...best[2].map((t,i)=>{const s=document.createElement(i?'span':'b');s.textContent=t;return s}));tip.hidden=false;const r=tip.getBoundingClientRect();const left=e.clientX+14+r.width>innerWidth?e.clientX-14-r.width:e.clientX+14;tip.style.left=left+'px';tip.style.top=Math.max(8,e.clientY-r.height-10)+'px'});
document.addEventListener('pointerleave',hide);
// Checks for a new block every 15 s and swaps in the fresh page body, keeping the scroll position.
setInterval(async()=>{try{const t=await (await fetch('/api/tip.json',{cache:'no-store'})).json();if(!t.hash||t.hash===document.body.dataset.tip)return;const html=await (await fetch(location.href,{cache:'no-store'})).text();const doc=new DOMParser().parseFromString(html,'text/html');for(const sel of ['header.bar .status','main']){const a=document.querySelector(sel),b=doc.querySelector(sel);if(a&&b)a.replaceWith(b)}document.body.dataset.tip=t.hash}catch{}},15000);
document.getElementById('theme').addEventListener('click',()=>{const r=document.documentElement;const dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',r.dataset.theme)}catch{}});
</script>
</body>
</html>`;
}

function windowTabs(current: WindowName, base: string): string {
  return `<div class="seg">${(Object.keys(WINDOWS) as WindowName[])
    .map((w) => `<a href="${base}?window=${w}"${w === current ? ' aria-current="true"' : ''} title="${w === 'all' ? 'All blocks' : `${int(WINDOWS[w])} blocks`}">${WINDOW_SHORT[w]}</a>`)
    .join('')}</div>`;
}

const range = (lo: number, hi: number, fmt: (v: number) => string): string => `${fmt(lo)} to ${fmt(hi)}`;

function stats(net: Network, rows: MinerRow[], target: number): string {
  const tile = (label: string, value: string, sub: string, title = ''): string =>
    `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><div class="k">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
  const plusMinus = (net.rateInterval.hi - net.rateInterval.lo) / 2 / net.rate;
  const top = rows[0];
  return `<div class="stats">
${tile('Hashrate', rate(net.rate), `±${pct(plusMinus, 0)}`, `${rate(net.rateInterval.lo)} to ${rate(net.rateInterval.hi)}`)}
${tile('Difficulty', bigNum(net.difficulty), `<span class="${net.difficultyChange >= 0 ? 'up' : 'down'}">${net.difficultyChange >= 0 ? '+' : '−'}${pct(Math.abs(net.difficultyChange))}</span>`)}
${tile('Average block time', clock(net.meanInterval), `target ${clock(target)}`)}
${tile('Active miners', int(rows.length), `last ${int(net.blocks)} blocks`)}
${top === undefined ? '' : tile('Largest miner', pct(top.share), esc(minerTitle(top).text), `${pct(top.shareInterval.lo)} to ${pct(top.shareInterval.hi)}`)}
</div>`;
}

/** 194 as "3m 14s". */
function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function verdict(r: MinerRow): { fits: boolean; word: string } {
  const c = r.claim!;
  if (c.share > r.shareInterval.hi) return { fits: false, word: 'too high' };
  if (c.share < r.shareInterval.lo) return { fits: false, word: 'too low' };
  return { fits: true, word: 'matches' };
}

function claimCell(r: MinerRow): string {
  const c = r.claim;
  if (c === null) return '<td></td>';
  const v = verdict(r);
  const title = `${c.claim.source}, ${utc(c.claim.readAt).slice(0, 10)}`;
  return `<td title="${esc(title)}"><span class="claimed">${pct(c.share)}</span> <span class="${v.fits ? 'tag ok' : 'tag off'}">${v.word}</span></td>`;
}

/** The miners table; the claims column only appears when some row in it has a claim. */
function minerTable(ctx: PageCtx, rows: MinerRow[], ranks?: number[]): string {
  const claims = rows.some((r) => r.claim !== null);
  const head = `<thead><tr><th></th><th>Miner</th><th>Share of blocks</th><th class="n">Blocks</th><th class="n">Hashrate</th>${claims ? '<th>Pool claims</th>' : ''}<th class="n">Last block</th></tr></thead>`;
  return `<div class="scroll"><table>${head}<tbody>${minerRows(ctx, rows, claims, ranks)}</tbody></table></div>`;
}

function minerRows(ctx: PageCtx, rows: MinerRow[], claims: boolean, ranks?: number[]): string {
  const max = Math.max(0.05, ...rows.map((r) => Math.max(r.shareInterval.hi, r.claim?.share ?? 0)));
  return rows
    .map((r, i) => `<tr>
<td class="rank">${ranks?.[i] ?? i + 1}</td>
<td>${titleLink(r)}${r.labelled ? `<span class="sub">${r.scripts} address${r.scripts === 1 ? '' : 'es'}</span>` : r.tags.length > 0 || r.paysOut ? `<span class="sub mono">${esc(short(r.name))}</span>` : ''}</td>
<td title="${pct(r.shareInterval.lo)} to ${pct(r.shareInterval.hi)}"><div class="share">${shareBar(r.share, r.shareInterval.lo, r.shareInterval.hi, max, r.claim?.share ?? null)}<span class="pctv">${pct(r.share)}</span></div></td>
<td class="n">${int(r.blocks)}</td>
<td class="n" title="${esc(range(r.rateInterval.lo, r.rateInterval.hi, rate))}">${rate(r.rate)}</td>
${claims ? claimCell(r) : ''}
<td class="n"><span class="age">${ago(ctx.now - r.lastTime)}</span></td>
</tr>`)
    .join('');
}


function blockRows(ctx: PageCtx, list: RecentBlock[]): string {
  return list
    .map((b) => `<tr>
<td class="n mono">${int(b.height)}</td>
<td>${minerLink(b.id, b.name)}</td>
<td class="muted" title="${utc(b.time)} UTC">${ago(ctx.now - b.time)} ago</td>
<td class="n">${int(b.txCount)}</td>
<td class="n">${prl(b.reward)}</td>
<td class="n">${b.interval === null ? '' : b.interval < 0 ? 'before parent' : clock(b.interval)}</td>
</tr>`)
    .join('');
}

const BLOCK_HEAD = '<thead><tr><th class="n">Height</th><th>Miner</th><th>Mined</th><th class="n">Txs</th><th class="n">Reward PRL</th><th class="n">Time to find</th></tr></thead>';

export function overview(ctx: PageCtx, window: WindowName): string {
  const net = network(ctx, window);
  if (net === null) return layout(ctx, 'Pearl mining', '/', '<div class="card empty">No blocks indexed yet. Start the indexer; this page fills in as blocks arrive.</div>');
  const rows = miners(ctx, window);
  const per = Math.max(1, Math.round(net.blocks / 30));
  const pts = series(ctx, window, per);
  const ivs = intervals(ctx, window).filter((s) => s >= 0);
  return layout(ctx, 'Pearl mining', '/', `
<div class="pagebar"><span class="muted">Last ${int(net.blocks)} blocks</span>${windowTabs(window, '/')}</div>
${stats(net, rows, ctx.network.targetSpacing)}
<section class="card">
  <div class="head"><h2>Miners</h2><span class="muted">${int(rows.length)}</span></div>
  ${minerTable(ctx, rows.slice(0, 10))}
  <div class="foot"><a class="more" href="/miners?window=${window}">All ${int(rows.length)} miners</a></div>
</section>
<div class="grid even">
  <section class="card"><div class="head"><h2>Hashrate</h2></div>${lineChart(pts, (p) => p.rate, { label: 'Hashrate', unit: rate, band: (p) => [p.rateLo, p.rateHi], extra: (p) => `difficulty ${bigNum(p.difficulty)}` })}</section>
  <section class="card"><div class="head"><h2>Block times</h2></div>${intervalHistogram(ivs, ctx.network.targetSpacing)}</section>
</div>
<section class="card">
  <div class="head"><h2>Latest blocks</h2><a class="more inline" href="/blocks">All blocks</a></div>
  <div class="scroll"><table>${BLOCK_HEAD}<tbody>${blockRows(ctx, recentBlocks(ctx, 10))}</tbody></table></div>
</section>`);
}

const PAGE = 50;

export function minersPage(ctx: PageCtx, window: WindowName, query = '', page = 1): string {
  const net = network(ctx, window);
  if (net === null) return layout(ctx, 'Miners: Pearl mining', '/miners', '<div class="card empty">No blocks indexed yet.</div>');
  const rows = miners(ctx, window);
  const chartRows = rows.filter((r, i) => i < 3 || r.share >= 0.01).slice(0, 12);
  const q = query.trim().toLowerCase();
  const ranked = rows.map((row, i) => ({ row, rank: i + 1 }));
  const found = q === '' ? ranked : ranked.filter(({ row }) => row.name.toLowerCase().includes(q) || minerTitle(row).text.toLowerCase().includes(q) || row.tags.some((t) => t.toLowerCase().includes(q)));
  const pages = Math.max(1, Math.ceil(found.length / PAGE));
  const at = Math.min(Math.max(1, page), pages);
  const shown = found.slice((at - 1) * PAGE, at * PAGE);
  const link = (p: number): string => `/miners?window=${window}${q ? `&q=${encodeURIComponent(query.trim())}` : ''}${p > 1 ? `&page=${p}` : ''}`;
  const pager = pages <= 1 ? '' : `<div class="foot pager">${at > 1 ? `<a class="more" href="${link(at - 1)}">Previous</a>` : '<span></span>'}<span class="muted">Page ${at} of ${pages}</span>${at < pages ? `<a class="more" href="${link(at + 1)}">Next</a>` : '<span></span>'}</div>`;
  return layout(ctx, 'Miners: Pearl mining', '/miners', `
<div class="pagebar"><span class="muted">Last ${int(net.blocks)} blocks</span>${windowTabs(window, '/miners')}</div>
<section class="card">
  <div class="head"><h2>Share of blocks</h2></div>
  ${rankChart(chartRows.map((row) => ({ row, href: minerHref(row.id), label: minerTitle(row).text, mono: minerTitle(row).mono })), 1160)}
</section>
<section class="card">
  <div class="head"><h2>Miners</h2><span class="muted">${q ? `${int(found.length)} of ${int(rows.length)}` : int(rows.length)}</span>
    <form class="search" action="/miners" method="get"><input type="hidden" name="window" value="${window}"><input type="search" name="q" value="${esc(query.trim())}" placeholder="Pool or address" aria-label="Search miners"></form></div>
  ${shown.length === 0 ? '<p class="muted">No miner matches.</p>' : minerTable(ctx, shown.map((s) => s.row), shown.map((s) => s.rank))}
  ${pager}
</section>`);
}

export function blocksPage(ctx: PageCtx, below: number | null): string {
  const list = recentBlocks(ctx, 100, below === null ? {} : { below });
  const last = list[list.length - 1];
  return layout(ctx, 'Blocks: Pearl mining', '/blocks', `<section class="card">
<div class="head"><h2>Blocks</h2></div>
<div class="scroll"><table>${BLOCK_HEAD}<tbody>${blockRows(ctx, list)}</tbody></table></div>
${last !== undefined && last.height > 0 ? `<a class="more" href="/blocks?below=${last.height}">Older blocks</a>` : ''}
</section>`);
}

export function minerPage(ctx: PageCtx, id: string, window: WindowName): string | null {
  const all = miners(ctx, 'all').find((r) => r.id === id);
  if (all === undefined) return null;
  const current = miners(ctx, window).find((r) => r.id === id);
  const net = network(ctx, window);
  const entry = id.startsWith('label:') ? ctx.labels.entries.find((e) => e.label === all.name) : undefined;
  const scripts = entry !== undefined ? entry.scripts : [all.name];
  const hist = shareHistory(ctx, 14, WINDOWS.day).counts.get(id) ?? new Array<number>(14).fill(0);
  const tile = (k: string, v: string, s: string, title = ''): string => `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><div class="k">${k}</div><div class="v">${v}</div><div class="s">${s}</div></div>`;
  const statsRow = `<div class="stats">
${tile('Share of blocks', current === undefined ? '0%' : pct(current.share), current === undefined ? `none of the last ${int(net?.blocks ?? 0)}` : `${pct(current.shareInterval.lo)} to ${pct(current.shareInterval.hi)}`)}
${tile('Blocks', int(current?.blocks ?? 0), `of ${int(net?.blocks ?? 0)}`)}
${tile('Hashrate', current === undefined ? '0' : rate(current.rate), current === undefined ? '' : `${rate(current.rateInterval.lo)} to ${rate(current.rateInterval.hi)}`)}
${tile('Last block', int(all.lastHeight), `${ago(ctx.now - all.lastTime)} ago`)}
${tile('Per day, 14 days', sparkline(hist, WINDOWS.day), `${int(all.empty)} of ${int(all.blocks)} blocks empty`)}
</div>`;

  let claim = '';
  if (current?.claim) {
    const c = current.claim;
    const v = verdict(current);
    claim = `<section class="card">
<div class="head"><h2>Pool claim</h2><span class="${v.fits ? 'tag ok' : 'tag off'}">${v.word}</span></div>
<div class="stats inner">
${tile('Pool claims', pct(c.share), `${esc(c.claim.source)}, ${utc(c.claim.readAt).slice(0, 10)}`)}
${tile('Found on chain', pct(current.share), `${pct(current.shareInterval.lo)} to ${pct(current.shareInterval.hi)}`)}
${tile('Blocks expected', int(Math.round(c.expected)), '')}
${tile('Blocks found', int(current.blocks), '')}
</div>
</section>`;
  }
  const l = links(ctx, id);
  const linkItems = [
    ...l.coSpent.slice(0, 10).map((c) => `<li>Spent together with ${c.with.map((w) => minerLink(w, w.startsWith('label:') ? w.slice(6) : w)).join(', ')} in block ${int(c.height)}</li>`),
    ...l.fanOut.slice(0, 10).map((c) => `<li>Paid out to ${int(c.outputs)} addresses in block ${int(c.height)}</li>`),
  ];
  return layout(ctx, `${all.labelled ? all.name : short(all.name)}: Pearl mining`, '/miners', `
<div class="title"><h1 class="${all.labelled ? '' : 'mono'}">${esc(all.labelled ? all.name : all.name)}</h1>${windowTabs(window, minerHref(id))}</div>
${statsRow}
${claim}
<div class="grid even">
<section class="card"><div class="head"><h2>Addresses</h2><span class="muted">${entry !== undefined ? esc(entry.source) : ''}</span></div>
<ul class="plain">${scripts.map((s) => `<li class="mono">${esc(s)}</li>`).join('')}</ul>
${all.tags.length > 0 ? `<p class="muted">Coinbase text: ${all.tags.map((t) => `"${esc(t)}"`).join(', ')}</p>` : ''}</section>
<section class="card"><div class="head"><h2>Linked by spending</h2></div>
${linkItems.length === 0 ? '<p class="muted">None</p>' : `<ul class="plain">${linkItems.join('')}</ul>`}</section>
</div>
<section class="card"><div class="head"><h2>Latest blocks</h2></div>
<div class="scroll"><table>${BLOCK_HEAD}<tbody>${blockRows(ctx, recentBlocks(ctx, 15, { id }))}</tbody></table></div></section>`);
}
