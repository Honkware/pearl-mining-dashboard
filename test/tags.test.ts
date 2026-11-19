// The miner's text out of coinbase scripts, with stray printable bytes of the
// height and extra nonce removed. The inputs are runs seen on mainnet blocks.
import { expect, test } from 'vitest';
import { cleanTag } from '../src/facts.js';

test('a pool tag loses the stray bytes in front of it', () => {
  expect(cleanTag('Yj/pearl-pool/')).toBe('/pearl-pool/');
  expect(cleanTag('fZj/pearl-pool/')).toBe('/pearl-pool/');
});

test("pearld's default flag and noise around it leave nothing", () => {
  expect(cleanTag("m~T' /P2SH/pearld/")).toBe('');
  expect(cleanTag('/P2SH/pearld/')).toBe('');
  expect(cleanTag('Y<Mf')).toBe('');
});

test("a pool's tag is kept and the extra-nonce bytes around it are not", () => {
  expect(cleanTag('/&%j/pool.kryptex.com/')).toBe('/pool.kryptex.com/');
  expect(cleanTag('/pool.kryptex.com/NOCKCHAIN-AI-POW-AUX/')).toBe('/pool.kryptex.com/ /NOCKCHAIN-AI-POW-AUX/');
  expect(cleanTag('/pool.kryptex.com/ /[D5/')).toBe('/pool.kryptex.com/');
  expect(cleanTag('/F2Pool/')).toBe('/F2Pool/');
});

test('a message in plain words is kept', () => {
  expect(cleanTag('The native currency for machines and humans. Total')).toBe('The native currency for machines and humans. Total');
});
