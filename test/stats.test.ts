// The expected values were computed with scipy.stats 1.x (beta.ppf, gamma.ppf,
// binom.cdf, binom.sf, poisson.cdf, poisson.sf), independently of this code.
import { describe, expect, test } from 'vitest';
import { concentration, type MinerRow } from '../src/analysis.js';
import { binomialAtLeast, binomialAtMost, countInterval, poissonAtLeast, poissonAtMost, shareInterval } from '../src/stats.js';

describe('share intervals', () => {
  test('five of ten gives the textbook Clopper-Pearson interval', () => {
    const { lo, hi } = shareInterval(5, 10);
    expect(lo).toBeCloseTo(0.18708602844739855, 12);
    expect(hi).toBeCloseTo(0.8129139715526015, 12);
  });

  test('a large pool over a week matches scipy', () => {
    const { lo, hi } = shareInterval(1371, 3102);
    expect(lo).toBeCloseTo(0.4243970004608826, 10);
    expect(hi).toBeCloseTo(0.45965839266888325, 10);
  });

  test('a miner with one block in a day has a tiny lower bound and a real upper one', () => {
    const { lo, hi } = shareInterval(1, 444);
    expect(lo).toBeCloseTo(5.7020464326230784e-5, 14);
    expect(hi).toBeCloseTo(0.012484332579556017, 12);
  });

  test('none and all are closed at 0 and 1', () => {
    expect(shareInterval(0, 20).lo).toBe(0);
    expect(shareInterval(20, 20).hi).toBe(1);
    expect(shareInterval(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe('count intervals', () => {
  test('no events still allows a mean up to 3.69', () => {
    expect(countInterval(0).lo).toBe(0);
    expect(countInterval(0).hi).toBeCloseTo(3.688879454113936, 10);
  });

  test('ten events matches the Garwood interval', () => {
    const { lo, hi } = countInterval(10);
    expect(lo).toBeCloseTo(4.7953886961324335, 9);
    expect(hi).toBeCloseTo(18.39035604201778, 9);
  });
});

describe('tails', () => {
  test('finding 1371 of 3102 blocks at a claimed 47.8% is unlikely', () => {
    expect(binomialAtMost(1371, 3102, 0.478)).toBeCloseTo(3.1060584027675794e-5, 14);
    expect(binomialAtLeast(1371, 3102, 0.478)).toBeCloseTo(0.9999733508864155, 12);
  });

  test('small binomial tails match', () => {
    expect(binomialAtMost(3, 100, 0.1)).toBeCloseTo(0.00783648712118442, 14);
  });

  test('poisson tails match', () => {
    expect(poissonAtMost(5, 12.5)).toBeCloseTo(0.014822874597441575, 14);
    expect(poissonAtLeast(20, 12.5)).toBeCloseTo(0.03059412892699659, 14);
  });

  test('edges are exact', () => {
    expect(binomialAtMost(10, 10, 0.3)).toBe(1);
    expect(binomialAtLeast(0, 10, 0.3)).toBe(1);
    expect(poissonAtLeast(0, 4)).toBe(1);
  });
});

describe('concentration', () => {
  const row = (blocks: number, labelled: boolean): MinerRow => ({ blocks, labelled }) as MinerRow;

  test('two pools past half, with each unnamed address on its own', () => {
    const c = concentration([row(40, true), row(30, true), row(20, false), row(10, false)])!;
    expect(c.toHalf).toBe(2);
    expect(c.top3).toBeCloseTo(0.9, 12);
    expect(c.effective).toBeCloseTo(1 / 0.3, 12);
    expect(c.unnamed).toBeCloseTo(0.3, 12);
  });

  test('exactly half is not past half', () => {
    expect(concentration([row(50, true), row(50, true)])!.toHalf).toBe(2);
    expect(concentration([])).toBeNull();
  });
});
