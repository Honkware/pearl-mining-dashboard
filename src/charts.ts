// SVG charts drawn on the server. Colours come from CSS custom properties,
// so one drawing serves both themes; sizes are in viewBox units and the SVG
// scales to its column.
import type { MinerRow, SeriesPoint } from './analysis.js';

export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const f = (n: number): string => (Math.round(n * 10) / 10).toString();

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function niceStep(max: number, ticks: number): number {
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

export interface RankRow {
  row: MinerRow;
  href: string;
  label: string;
  mono: boolean;
}

/**
 * Dot-and-interval ranking of identities by share of blocks. A claimed share
 * is a diamond on the same row: hollow when inside the 95% interval, filled
 * with the accent when outside it.
 */
export function rankChart(items: RankRow[], width = 760): string {
  const rowH = 30;
  const left = 230;
  const right = 90;
  const top = 26;
  const plotW = width - left - right;
  const maxShare = Math.max(0.05, ...items.map((i) => Math.max(i.row.shareInterval.hi, i.row.claim?.share ?? 0)));
  const step = niceStep(maxShare, 5);
  const xMax = Math.ceil(maxShare / step) * step;
  const x = (s: number): number => left + (s / xMax) * plotW;
  const height = top + items.length * rowH + 8;
  const parts: string[] = [];
  for (let t = 0; t <= xMax + 1e-9; t += step) {
    parts.push(`<line class="grid" x1="${f(x(t))}" x2="${f(x(t))}" y1="${top - 6}" y2="${height - 4}"/>`);
    parts.push(`<text class="tick" x="${f(x(t))}" y="${top - 12}" text-anchor="middle">${Math.round(t * 100)}%</text>`);
  }
  parts.push(`<text class="tick" x="${width - 4}" y="${top - 12}" text-anchor="end">blocks</text>`);
  items.forEach((item, i) => {
    const y = top + i * rowH + rowH / 2;
    const r = item.row;
    const claim = r.claim;
    const outside = claim !== null && (claim.share < r.shareInterval.lo || claim.share > r.shareInterval.hi);
    const title = `${item.label}: ${r.blocks} blocks, ${pct(r.share)} (95% interval ${pct(r.shareInterval.lo)} to ${pct(r.shareInterval.hi)})` +
      (claim === null ? '' : `; claimed ${pct(claim.share)} by ${claim.claim.source}`);
    parts.push(`<g class="rank-row"><title>${esc(title)}</title>`);
    if (i % 2 === 0) parts.push(`<rect class="stripe" x="0" y="${y - rowH / 2}" width="${width}" height="${rowH}"/>`);
    parts.push(`<a href="${esc(item.href)}"><text class="name${item.mono ? ' mono' : ''}" x="${left - 14}" y="${y + 4}" text-anchor="end">${esc(item.label)}</text></a>`);
    parts.push(`<line class="ci" x1="${f(x(r.shareInterval.lo))}" x2="${f(x(r.shareInterval.hi))}" y1="${y}" y2="${y}"/>`);
    parts.push(`<circle class="est" cx="${f(x(r.share))}" cy="${y}" r="4.5"/>`);
    if (claim !== null) {
      const cx = x(claim.share);
      parts.push(`<path class="claim${outside ? ' off' : ''}" d="M${f(cx)} ${y - 7}L${f(cx + 7)} ${y}L${f(cx)} ${y + 7}L${f(cx - 7)} ${y}Z"/>`);
    }
    parts.push(`<text class="count" x="${width - 4}" y="${y + 4}" text-anchor="end">${r.blocks.toLocaleString('en-US')}</text>`);
    parts.push('</g>');
  });
  return `<svg class="chart rank" viewBox="0 0 ${width} ${height}" role="img" aria-label="Share of blocks by identity">${parts.join('')}</svg>`;
}

/** A small line chart; with `band`, the interval is drawn under the line. */
export function lineChart(points: SeriesPoint[], pick: (p: SeriesPoint) => number, opts: { label: string; unit: (v: number) => string; band?: (p: SeriesPoint) => [number, number]; width?: number }): string {
  const width = opts.width ?? 560;
  const height = 150;
  const pad = { l: 64, r: 10, t: 8, b: 22 };
  if (points.length < 2) return `<p class="empty">Not enough blocks yet for ${esc(opts.label.toLowerCase())}.</p>`;
  const vals = points.flatMap((p) => (opts.band ? [...opts.band(p), pick(p)] : [pick(p)]));
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) {
    hi += Math.abs(hi) * 0.05 || 1;
    lo -= Math.abs(lo) * 0.05 || 1;
  }
  const t0 = points[0]!.time;
  const t1 = points[points.length - 1]!.time;
  const x = (t: number): number => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - pad.l - pad.r);
  const y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * (height - pad.t - pad.b);
  const parts: string[] = [];
  for (const v of [lo, (lo + hi) / 2, hi]) {
    parts.push(`<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${f(y(v))}" y2="${f(y(v))}"/>`);
    parts.push(`<text class="tick" x="${pad.l - 6}" y="${f(y(v) + 4)}" text-anchor="end">${esc(opts.unit(v))}</text>`);
  }
  if (opts.band) {
    const upper = points.map((p) => `${f(x(p.time))},${f(y(opts.band!(p)[1]))}`);
    const lower = points.map((p) => `${f(x(p.time))},${f(y(opts.band!(p)[0]))}`).reverse();
    parts.push(`<polygon class="band" points="${[...upper, ...lower].join(' ')}"/>`);
  }
  let d = '';
  points.forEach((p, i) => {
    const px = f(x(p.time));
    const py = f(y(pick(p)));
    d += `${i === 0 ? 'M' : 'L'}${px} ${py}`;
  });
  parts.push(`<path class="line" d="${d}"/>`);
  const day = (t: number): string => new Date(t * 1000).toISOString().slice(5, 10);
  parts.push(`<text class="tick" x="${pad.l}" y="${height - 4}">${day(t0)}</text>`);
  parts.push(`<text class="tick" x="${width - pad.r}" y="${height - 4}" text-anchor="end">${day(t1)}</text>`);
  return `<svg class="chart line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(opts.label)}">${parts.join('')}</svg>`;
}

/**
 * Histogram of block intervals against what a steady network at the target
 * spacing would give: an exponential with mean `target`.
 */
export function intervalHistogram(intervals: number[], target: number, width = 560): string {
  const height = 150;
  const pad = { l: 10, r: 10, t: 8, b: 22 };
  if (intervals.length < 10) return '<p class="empty">Not enough blocks yet for the interval histogram.</p>';
  const binW = target / 4;
  const bins = 20;
  const counts = new Array<number>(bins).fill(0);
  for (const s of intervals) counts[Math.min(bins - 1, Math.max(0, Math.floor(s / binW)))]! += 1;
  const n = intervals.length;
  const expected = counts.map((_, i) => n * (Math.exp((-i * binW) / target) - (i === bins - 1 ? 0 : Math.exp((-(i + 1) * binW) / target))));
  const top = Math.max(...counts, ...expected);
  const bw = (width - pad.l - pad.r) / bins;
  const y = (v: number): number => pad.t + (1 - v / top) * (height - pad.t - pad.b);
  const parts: string[] = [];
  counts.forEach((c, i) => {
    const title = `${f(i * binW)} to ${i === bins - 1 ? 'more' : f((i + 1) * binW)} s: ${c} blocks, ${f(expected[i]!)} expected`;
    parts.push(`<rect class="bar" x="${f(pad.l + i * bw + 1)}" y="${f(y(c))}" width="${f(bw - 2)}" height="${f(y(0) - y(c))}"><title>${esc(title)}</title></rect>`);
  });
  const curve = expected.map((e, i) => `${i === 0 ? 'M' : 'L'}${f(pad.l + (i + 0.5) * bw)} ${f(y(e))}`).join('');
  parts.push(`<path class="expect" d="${curve}"/>`);
  parts.push(`<line class="axis" x1="${pad.l}" x2="${width - pad.r}" y1="${f(y(0))}" y2="${f(y(0))}"/>`);
  for (const k of [0, 4, 8, 12, 16]) parts.push(`<text class="tick" x="${f(pad.l + k * bw)}" y="${height - 4}" text-anchor="middle">${Math.round(k * binW)}</text>`);
  parts.push(`<text class="tick" x="${width - pad.r}" y="${height - 4}" text-anchor="end">${Math.round(bins * binW)}+</text>`);
  return `<svg class="chart hist" viewBox="0 0 ${width} ${height}" role="img" aria-label="Block interval histogram">${parts.join('')}</svg>`;
}

/** Blocks per bucket as a short line, for a table row. */
export function sparkline(counts: number[], per: number): string {
  const w = 96;
  const h = 22;
  const max = Math.max(1, ...counts);
  const pts = counts.map((c, i) => `${f((i / Math.max(1, counts.length - 1)) * (w - 4) + 2)},${f(h - 3 - (c / max) * (h - 6))}`).join(' ');
  const title = `Blocks per ${per}: ${counts.join(', ')}`;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><title>${esc(title)}</title><polyline points="${pts}"/></svg>`;
}

/**
 * A share as a bar in a table cell, scaled to `max`. The whisker is the 95%
 * interval; a diamond marks a claimed share, filled when outside the interval.
 */
export function shareBar(share: number, lo: number, hi: number, max: number, claim: number | null): string {
  const w = 120;
  const h = 14;
  const x = (v: number): number => 1 + (Math.min(v, max) / max) * (w - 8);
  const parts = [`<rect class="track" x="1" y="5" width="${w - 8}" height="4" rx="2"/>`, `<rect class="fill" x="1" y="5" width="${f(Math.max(1.5, x(share) - 1))}" height="4" rx="2"/>`];
  parts.push(`<line class="whisker" x1="${f(x(lo))}" x2="${f(x(hi))}" y1="7" y2="7"/><line class="whisker" x1="${f(x(lo))}" x2="${f(x(lo))}" y1="4" y2="10"/><line class="whisker" x1="${f(x(hi))}" x2="${f(x(hi))}" y1="4" y2="10"/>`);
  if (claim !== null) {
    const cx = x(claim);
    const off = claim < lo || claim > hi;
    parts.push(`<path class="claim${off ? ' off' : ''}" d="M${f(cx)} 1.5L${f(cx + 5.5)} 7L${f(cx)} 12.5L${f(cx - 5.5)} 7Z"/>`);
  }
  return `<svg class="sharebar" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">${parts.join('')}</svg>`;
}
