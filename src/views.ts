// HTML pages. The overview is for a glance: headline numbers, the miners,
// the latest blocks. Definitions live in tooltips and on the method page.
import {
  WINDOWS,
  claimEffort,
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
import { effortStrip, esc, intervalHistogram, lineChart, pct, rankChart, shareBar, sparkline } from './charts.js';

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
// Changes on every start, so browsers never reuse a stylesheet from an older build.
const STYLE_VERSION = Date.now().toString(36);
const WINDOW_SHORT: Record<WindowName, string> = { day: '1D', week: '1W', month: '1M', all: 'All' };

export interface PageCtx extends Context {
  now: number;
  /** Height pearld reports, to say how far behind the index is. */
  nodeHeight?: number | null;
}

function short(name: string): string {
  return name.length > 22 ? `${name.slice(0, 10)}…${name.slice(-6)}` : name;
}

function minerLink(id: string, name: string, labelled = id.startsWith('label:')): string {
  return labelled
    ? `<a class="who" href="${minerHref(id)}">${esc(name)}</a>`
    : `<a class="who mono" href="${minerHref(id)}" title="${esc(name)}">${esc(short(name))}</a>`;
}

function layout(ctx: PageCtx, title: string, current: string, body: string): string {
  const tip = recentBlocks(ctx, 1)[0];
  const nav = [['/', 'Overview'], ['/miners', 'Miners'], ['/blocks', 'Blocks'], ['/method', 'Method']]
    .map(([href, text]) => `<a href="${href}"${href === current ? ' aria-current="page"' : ''}>${text}</a>`)
    .join('');
  let notice = '';
  if (tip !== undefined && ctx.nodeHeight != null && ctx.nodeHeight - tip.height > 3) {
    notice = `<div class="notice">Indexing: block ${int(tip.height)} of ${int(ctx.nodeHeight)}. Numbers cover indexed blocks only.</div>`;
  } else if (tip !== undefined && ctx.now - tip.time > 3600) {
    notice = `<div class="notice">Newest block is ${ago(ctx.now - tip.time)} old. Numbers stop at block ${int(tip.height)}.</div>`;
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
<body>
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
<footer class="wrap">Computed from this server's own node. Pool numbers are claims from claims.json. <a href="/method">Method</a></footer>
<script>
document.getElementById('theme').addEventListener('click',()=>{const r=document.documentElement;const dark=r.dataset.theme?r.dataset.theme==='dark':matchMedia('(prefers-color-scheme: dark)').matches;r.dataset.theme=dark?'light':'dark';try{localStorage.setItem('theme',r.dataset.theme)}catch{}});
</script>
</body>
</html>`;
}

function windowTabs(current: WindowName, base: string): string {
  return `<div class="seg">${(Object.keys(WINDOWS) as WindowName[])
    .map((w) => `<a href="${base}?window=${w}"${w === current ? ' aria-current="true"' : ''} title="${w === 'all' ? 'Every indexed block' : `Last ${int(WINDOWS[w])} blocks`}">${WINDOW_SHORT[w]}</a>`)
    .join('')}</div>`;
}

const range = (lo: number, hi: number, fmt: (v: number) => string): string => `95% interval ${fmt(lo)} to ${fmt(hi)}`;

function stats(net: Network, top: MinerRow | undefined, target: number): string {
  const tile = (label: string, value: string, sub: string, title = ''): string =>
    `<div class="stat"${title ? ` title="${esc(title)}"` : ''}><div class="k">${label}</div><div class="v">${value}</div><div class="s">${sub}</div></div>`;
  const plusMinus = (net.rateInterval.hi - net.rateInterval.lo) / 2 / net.rate;
  const effortClass = net.effort <= 1 ? 'good' : net.effort > 1.25 ? 'bad' : '';
  return `<div class="stats">
${tile('Hashrate', rate(net.rate), `±${pct(plusMinus, 0)}`, `${range(net.rateInterval.lo, net.rateInterval.hi, rate)}. In pearld's units, as getnetworkhashps.`)}
${tile('Difficulty', bigNum(net.difficulty), `<span class="${net.difficultyChange >= 0 ? 'up' : 'down'}">${net.difficultyChange >= 0 ? '+' : '−'}${pct(Math.abs(net.difficultyChange))}</span> this window`)}
${tile('Block time', `${net.meanInterval.toFixed(0)}s`, `target ${target}s`)}
${tile('Network effort', `<span class="${effortClass}">${pct(net.effort, 0)}</span>`, 'time taken vs expected', 'The window took this share of the time its blocks should take at the target spacing.')}
${top === undefined ? '' : tile('Largest miner', pct(top.share), esc(top.labelled ? top.name : short(top.name)), range(top.shareInterval.lo, top.shareInterval.hi, pct))}
</div>`;
}

function claimCell(r: MinerRow): string {
  const c = r.claim;
  if (c === null) return '<td class="muted">none</td>';
  const outside = c.share < r.shareInterval.lo || c.share > r.shareInterval.hi;
  const below = r.blocks < c.expected;
  const p = below ? c.atMost : c.atLeast;
  const title = `${c.claim.source} claims ${pct(c.share)} (read ${utc(c.claim.readAt).slice(0, 10)}). Found ${r.blocks} of ${c.expected.toFixed(0)} expected. Probability of ${below ? 'this few or fewer' : 'this many or more'} if the claim were true: ${p < 0.0001 ? 'under 0.0001' : p.toFixed(4)}.`;
  return `<td title="${esc(title)}"><span class="claimed">${pct(c.share)}</span> <span class="${outside ? 'tag off' : 'tag ok'}">${outside ? (c.share > r.shareInterval.hi ? 'too high' : 'too low') : 'fits'}</span></td>`;
}

function minerRows(ctx: PageCtx, rows: MinerRow[], start = 0): string {
  const max = Math.max(0.05, ...rows.map((r) => Math.max(r.shareInterval.hi, r.claim?.share ?? 0)));
  return rows
    .map((r, i) => `<tr>
<td class="rank">${start + i + 1}</td>
<td>${minerLink(r.id, r.name, r.labelled)}${r.labelled ? `<span class="sub">${r.scripts} address${r.scripts === 1 ? '' : 'es'}</span>` : ''}</td>
<td class="share" title="${esc(range(r.shareInterval.lo, r.shareInterval.hi, pct))}">${shareBar(r.share, r.shareInterval.lo, r.shareInterval.hi, max, r.claim?.share ?? null)}<span class="pctv">${pct(r.share)}</span></td>
<td class="n">${int(r.blocks)}</td>
<td class="n" title="${esc(range(r.rateInterval.lo, r.rateInterval.hi, rate))}">${rate(r.rate)}</td>
${claimCell(r)}
<td class="n"><span class="age">${ago(ctx.now - r.lastTime)}</span></td>
</tr>`)
    .join('');
}

const MINER_HEAD = '<thead><tr><th></th><th>Miner</th><th>Share of blocks</th><th class="n">Blocks</th><th class="n">Hashrate</th><th>Claimed</th><th class="n">Last block</th></tr></thead>';

function effortCell(b: RecentBlock, target: number): string {
  if (b.interval === null) return '<td class="n"></td>';
  const e = b.interval / target;
  return `<td class="n"><span class="${e <= 1 ? 'good' : e > 2 ? 'bad' : ''}" title="${b.interval}s after its parent, target ${target}s">${pct(Math.max(0, e), 0)}</span></td>`;
}

function blockRows(ctx: PageCtx, list: RecentBlock[]): string {
  return list
    .map((b) => `<tr>
<td class="n mono">${int(b.height)}</td>
<td>${minerLink(b.id, b.name)}</td>
<td class="muted" title="${utc(b.time)} UTC">${ago(ctx.now - b.time)} ago</td>
<td class="n">${int(b.txCount)}</td>
<td class="n">${prl(b.reward)}</td>
${effortCell(b, ctx.network.targetSpacing)}
</tr>`)
    .join('');
}

const BLOCK_HEAD = '<thead><tr><th class="n">Height</th><th>Miner</th><th>Mined</th><th class="n">Txs</th><th class="n">Reward PRL</th><th class="n" title="Time since the previous block over the 194 s target">Effort</th></tr></thead>';

export function overview(ctx: PageCtx, window: WindowName): string {
  const net = network(ctx, window);
  if (net === null) return layout(ctx, 'Pearl mining', '/', '<div class="card empty">No blocks indexed yet. Start the indexer; this page fills in as blocks arrive.</div>');
  const rows = miners(ctx, window);
  const per = Math.max(1, Math.round(net.blocks / 30));
  const pts = series(ctx, window, per);
  const ivs = intervals(ctx, window).filter((s) => s >= 0);
  return layout(ctx, 'Pearl mining', '/', `
${stats(net, rows[0], ctx.network.targetSpacing)}
<div class="grid">
  <section class="card">
    <div class="head"><h2>Miners</h2><span class="muted">${int(rows.length)} in the last ${int(net.blocks)} blocks</span>${windowTabs(window, '/')}</div>
    <div class="scroll"><table>${MINER_HEAD}<tbody>${minerRows(ctx, rows.slice(0, 10))}</tbody></table></div>
    <a class="more" href="/miners?window=${window}">All ${int(rows.length)} miners</a>
  </section>
  <div class="side">
    <section class="card"><div class="head"><h2>Hashrate</h2><span class="muted">per ${int(per)} blocks</span></div>${lineChart(pts, (p) => p.rate, { label: 'Hashrate', unit: rate, band: (p) => [p.rateLo, p.rateHi], width: 420 })}</section>
    <section class="card"><div class="head"><h2>Difficulty</h2></div>${lineChart(pts, (p) => p.difficulty, { label: 'Difficulty', unit: bigNum, step: true, width: 420 })}</section>
    <section class="card"><div class="head"><h2>Block times</h2><span class="muted">vs a steady ${ctx.network.targetSpacing}s</span></div>${intervalHistogram(ivs, ctx.network.targetSpacing, 420)}</section>
  </div>
</div>
<section class="card">
  <div class="head"><h2>Latest blocks</h2><a class="more inline" href="/blocks">All blocks</a></div>
  <div class="scroll"><table>${BLOCK_HEAD}<tbody>${blockRows(ctx, recentBlocks(ctx, 10))}</tbody></table></div>
</section>`);
}

export function minersPage(ctx: PageCtx, window: WindowName): string {
  const net = network(ctx, window);
  if (net === null) return layout(ctx, 'Miners: Pearl mining', '/miners', '<div class="card empty">No blocks indexed yet.</div>');
  const rows = miners(ctx, window);
  const chartRows = rows.filter((r, i) => i < 3 || r.share >= 0.01).slice(0, 12);
  const body = minerRows(ctx, rows.slice(0, 500));
  return layout(ctx, 'Miners: Pearl mining', '/miners', `
<section class="card">
  <div class="head"><h2>Share of blocks</h2><span class="muted">last ${int(net.blocks)} blocks, with 95% intervals and claims</span>${windowTabs(window, '/miners')}</div>
  ${rankChart(chartRows.map((row) => ({ row, href: minerHref(row.id), label: row.labelled ? row.name : short(row.name), mono: !row.labelled })))}
  <div class="key"><span><i class="k-dot"></i>found on chain, with interval</span><span><i class="k-claim"></i>claimed, fits</span><span><i class="k-claim off"></i>claimed, does not fit</span></div>
</section>
<section class="card">
  <div class="head"><h2>All miners</h2><span class="muted">${int(rows.length)}</span></div>
  <div class="scroll"><table>${MINER_HEAD}<tbody>${body}</tbody></table></div>
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
${tile('Share of blocks', current === undefined ? '0%' : pct(current.share), current === undefined ? `none of the last ${int(net?.blocks ?? 0)}` : `${pct(current.shareInterval.lo)} to ${pct(current.shareInterval.hi)}`, '95% interval')}
${tile('Blocks', int(current?.blocks ?? 0), `of ${int(net?.blocks ?? 0)} in the window`)}
${tile('Hashrate', current === undefined ? '0' : rate(current.rate), current === undefined ? '' : `${rate(current.rateInterval.lo)} to ${rate(current.rateInterval.hi)}`, "Estimated from blocks found, in pearld's units")}
${tile('Last block', int(all.lastHeight), `${ago(ctx.now - all.lastTime)} ago`)}
${tile('Per day, 14 days', sparkline(hist, WINDOWS.day), `${int(all.empty)} of ${int(all.blocks)} blocks empty`)}
</div>`;

  let claim = '';
  if (current?.claim) {
    const c = current.claim;
    const pts = claimEffort(ctx, id, c.share, window);
    const outside = c.share < current.shareInterval.lo || c.share > current.shareInterval.hi;
    const below = current.blocks < c.expected;
    const p = below ? c.atMost : c.atLeast;
    claim = `<section class="card">
<div class="head"><h2>Claim check</h2><span class="${outside ? 'tag off' : 'tag ok'}">${outside ? 'does not fit the chain' : 'fits the chain'}</span></div>
<div class="stats inner">
${tile('Claimed', pct(c.share), `${esc(c.claim.source)}, ${utc(c.claim.readAt).slice(0, 10)}`)}
${tile('Expected blocks', c.expected.toFixed(0), 'at the claimed share')}
${tile('Found', int(current.blocks), `luck ${pct(c.luck, 0)}`)}
${tile('Probability', p < 0.0001 ? '< 0.0001' : p.toFixed(4), below ? 'of this few or fewer' : 'of this many or more')}
</div>
<div class="head sub"><h3>Effort per block at the claimed share</h3></div>
${effortStrip(pts)}
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
<section class="card"><div class="head"><h2>Addresses</h2><span class="muted">${entry !== undefined ? `labelled from ${esc(entry.source)}` : 'not labelled'}</span></div>
<ul class="plain">${scripts.map((s) => `<li class="mono">${esc(s)}</li>`).join('')}</ul>
${all.tags.length > 0 ? `<p class="muted">Coinbase text: ${all.tags.map((t) => `"${esc(t)}"`).join(', ')}</p>` : ''}</section>
<section class="card"><div class="head"><h2>Linked by spending</h2></div>
${linkItems.length === 0 ? '<p class="muted">Nothing yet.</p>' : `<ul class="plain">${linkItems.join('')}</ul>`}</section>
</div>
<section class="card"><div class="head"><h2>Latest blocks</h2></div>
<div class="scroll"><table>${BLOCK_HEAD}<tbody>${blockRows(ctx, recentBlocks(ctx, 15, { id }))}</tbody></table></div></section>`);
}

export function methodPage(ctx: PageCtx): string {
  const item = (k: string, v: string): string => `<dt>${k}</dt><dd>${v}</dd>`;
  return layout(ctx, 'Method: Pearl mining', '/method', `<section class="card prose">
<div class="head"><h2>Method</h2></div>
<dl class="facts">
${item('Source', "Blocks this server's pearld accepted, followed one by one with pearljs's followChain. Reorganised blocks are undone and listed as stale.")}
${item('Windows', '1D, 1W and 1M are the last 445, 3,118 and 13,361 blocks: a day, a week and 30 days at the 194 s target.')}
${item('Miner', 'The address paid by the largest coinbase output. labels.json groups addresses under a name, each with its source. Coinbase text is shown but proves nothing.')}
${item('Share of blocks', 'Blocks found over blocks in the window, with a 95% Clopper-Pearson interval.')}
${item('Hashrate', "Work over time, as pearld's getnetworkhashps, with a Poisson interval on the block count. Pools quote hashrate in their own units, so compare shares, not hashrates.")}
${item('Effort', 'Per block: time since the previous block over 194 s. Network: the window\'s time over what its blocks should take. A pool\'s own effort counts shares and cannot be checked on chain.')}
${item('Claims', 'claims.json holds what pools or stats sites publish: a share, or a hashrate with the network hashrate from the same page. Each is tested against the window with a binomial tail. "Fits" means inside the 95% interval.')}
${item('Linked', 'Coinbase outputs of two addresses spent in one transaction suggest one owner. Merged only by editing labels.json.')}
${item('Fees', 'Coinbase reward minus subsidy: what the miner claimed.')}
</dl>
</section>`);
}
