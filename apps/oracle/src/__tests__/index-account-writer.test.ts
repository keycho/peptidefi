import { describe, expect, it } from 'vitest';
import BN from 'bn.js';
import {
  levelToFixedPoint,
  componentsHashToBytes,
} from '../solana/index-account-writer';

/**
 * Unit tests for the writer's pure encoders. The async send path is
 * exercised end-to-end by the Anchor test suite against the real
 * program (tests/biohash-index-program.ts); here we lock the two
 * conversion functions that turn JS-shape inputs into the on-chain
 * argument shapes.
 */

describe('levelToFixedPoint', () => {
  it('converts 1000.0000 to 10_000_000', () => {
    expect(levelToFixedPoint(1000).toString()).toBe('10000000');
    expect(levelToFixedPoint(1000.0).toString()).toBe('10000000');
  });

  it('rounds at the fourth decimal via toFixed', () => {
    // 980.4567 → 9804567
    expect(levelToFixedPoint(980.4567).toString()).toBe('9804567');
    // Sub-microcent precision discards: 980.45674 → 9804567 (Math round)
    expect(levelToFixedPoint(980.45674).toString()).toBe('9804567');
    expect(levelToFixedPoint(980.45675).toString()).toBe('9804568');
  });

  it('handles values that float-multiply would mishandle', () => {
    // The naive 980.46 * 10000 yields 9804599.999... which rounds
    // to 9804599, off-by-one from the correct 9804600. The toFixed
    // path keeps it exact.
    expect(levelToFixedPoint(980.46).toString()).toBe('9804600');
  });

  it('handles zero and near-zero', () => {
    expect(levelToFixedPoint(0).toString()).toBe('0');
    expect(levelToFixedPoint(0.0001).toString()).toBe('1');
  });

  it('throws on non-finite values', () => {
    expect(() => levelToFixedPoint(NaN)).toThrow();
    expect(() => levelToFixedPoint(Infinity)).toThrow();
    expect(() => levelToFixedPoint(-1)).toThrow();
  });

  it('returns a BN that survives a round-trip through Number for representable inputs', () => {
    const bn = levelToFixedPoint(1024.1379);
    expect(bn instanceof BN).toBe(true);
    expect(bn.toNumber()).toBe(10241379);
  });
});

describe('componentsHashToBytes', () => {
  it('decodes a 64-char hex string to 32 bytes', () => {
    const hex = 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899';
    const out = componentsHashToBytes(hex);
    expect(out.length).toBe(32);
    expect(out[0]).toBe(0xaa);
    expect(out[31]).toBe(0x99);
  });

  it('rejects uppercase hex (canonical form is lowercase)', () => {
    const hex = 'AABBCCDDEEFF00112233445566778899AABBCCDDEEFF00112233445566778899';
    expect(() => componentsHashToBytes(hex)).toThrow();
  });

  it('rejects short hex', () => {
    expect(() => componentsHashToBytes('abc')).toThrow();
  });

  it('rejects long hex', () => {
    expect(() => componentsHashToBytes('a'.repeat(65))).toThrow();
  });

  it('rejects non-hex characters', () => {
    expect(() => componentsHashToBytes('z' + 'a'.repeat(63))).toThrow();
  });
});
