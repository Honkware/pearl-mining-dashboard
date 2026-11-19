// Interval estimates and tail probabilities for counts of blocks.
//
// Blocks arrive as a Poisson process whose rate is the network's work rate
// over the work per block, and each block goes to a miner with probability
// equal to its share of the work. So an identity's block count in a window
// is binomial given the window's total, and Poisson given the window's
// length. Everything here is exact (no normal approximation), because the
// counts that matter most, a small pool's, are small.

const LANCZOS = [
  676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905,
  -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7,
];

export function lnGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lnGamma(1 - x);
  x -= 1;
  let a = 0.9999999999998099;
  const t = x + 7.5;
  for (let i = 0; i < LANCZOS.length; i++) a += LANCZOS[i]! / (x + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// Continued fraction for the incomplete beta function (Numerical Recipes, betacf).
function betacf(a: number, b: number, x: number): number {
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 1000; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + aa * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + aa / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (front * betacf(a, b, x)) / a;
  return 1 - (front * betacf(b, a, 1 - x)) / b;
}

/** Regularized lower incomplete gamma P(a, x). */
export function gammaInc(a: number, x: number): number {
  if (x <= 0) return 0;
  const lead = -x + a * Math.log(x) - lnGamma(a);
  if (x < a + 1) {
    let sum = 1 / a;
    let term = sum;
    for (let n = 1; n < 10000; n++) {
      term *= x / (a + n);
      sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(lead);
  }
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 10000; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - Math.exp(lead) * h;
}

// Bisection on a monotone increasing function from [lo, hi] to [0, 1].
function invert(f: (x: number) => number, p: number, lo: number, hi: number): number {
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < p) lo = mid;
    else hi = mid;
    if (hi - lo <= 1e-15 * Math.max(1, Math.abs(mid))) break;
  }
  return (lo + hi) / 2;
}

export function betaQuantile(p: number, a: number, b: number): number {
  return invert((x) => betaInc(x, a, b), p, 0, 1);
}

export function gammaQuantile(p: number, a: number): number {
  let hi = Math.max(1, a);
  while (gammaInc(a, hi) < p) hi *= 2;
  return invert((x) => gammaInc(a, x), p, 0, hi);
}

export interface Interval {
  lo: number;
  hi: number;
}

// Long windows hold hundreds of miners with the same few block counts, and
// each interval takes a few hundred incomplete-beta evaluations; computed once each.
const memo = new Map<string, Interval>();
function remember(key: string, make: () => Interval): Interval {
  let v = memo.get(key);
  if (v === undefined) {
    if (memo.size > 50_000) memo.clear();
    memo.set(key, (v = make()));
  }
  return v;
}

/** Clopper-Pearson interval for a binomial proportion: k successes in n trials. */
export function shareInterval(k: number, n: number, level = 0.95): Interval {
  return remember(`s${k},${n},${level}`, () => clopperPearson(k, n, level));
}

function clopperPearson(k: number, n: number, level: number): Interval {
  if (n === 0) return { lo: 0, hi: 1 };
  const alpha = 1 - level;
  return {
    lo: k === 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1),
    hi: k === n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k),
  };
}

/** Garwood interval for a Poisson mean given k events. */
export function countInterval(k: number, level = 0.95): Interval {
  return remember(`c${k},${level}`, () => garwood(k, level));
}

function garwood(k: number, level: number): Interval {
  const alpha = 1 - level;
  return {
    lo: k === 0 ? 0 : gammaQuantile(alpha / 2, k),
    hi: gammaQuantile(1 - alpha / 2, k + 1),
  };
}

/** P(X <= k) for X ~ Binomial(n, p). */
export function binomialAtMost(k: number, n: number, p: number): number {
  if (k < 0) return 0;
  if (k >= n) return 1;
  return betaInc(1 - p, n - k, k + 1);
}

/** P(X >= k) for X ~ Binomial(n, p). */
export function binomialAtLeast(k: number, n: number, p: number): number {
  if (k <= 0) return 1;
  if (k > n) return 0;
  return betaInc(p, k, n - k + 1);
}

/** P(X <= k) for X ~ Poisson(mean). */
export function poissonAtMost(k: number, mean: number): number {
  if (k < 0) return 0;
  return 1 - gammaInc(k + 1, mean);
}

/** P(X >= k) for X ~ Poisson(mean). */
export function poissonAtLeast(k: number, mean: number): number {
  if (k <= 0) return 1;
  return gammaInc(k, mean);
}
