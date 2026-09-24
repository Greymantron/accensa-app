import { describe, it, expect } from 'vitest';
import {
  createReceiptAnchorAbi,
  registerReceiptAnchorAbi,
  listReceiptAnchorAbiVersions,
  DEFAULT_RECEIPT_ANCHOR_ABI_VERSION,
  type ReceiptAnchorAbi,
} from './receipt-anchor';

/**
 * Test suite for the ReceiptAnchor ABI version registry.
 *
 * The registry (see `receipt-anchor.ts`) is the bridge between this SDK's
 * stable, version-independent shapes (`BatchRecord` / boolean verify result)
 * and the raw method names + field layouts of whatever `ReceiptAnchor`
 * contract deployment is being talked to. These tests pin down:
 *
 *  1. the default version a caller gets when none is specified,
 *  2. the exact method names and raw->stable reshapes v1 performs,
 *  3. the registry's lookups, error behavior, and extension points,
 *  4. backwards compatibility: that a differently-shaped legacy ABI still
 *     resolves to the same stable shapes on this side of the abstraction.
 *
 * This file contains no network I/O and never touches a Stellar RPC
 * endpoint; every test exercises the pure, portable registry module.
 */

/** Asserts defaulting and the exact v1 method names, matching the deployed contract. */
describe('createReceiptAnchorAbi', () => {
  it('defaults to the current (v1) ABI version', () => {
    const abi = createReceiptAnchorAbi();
    expect(abi.version).toBe(DEFAULT_RECEIPT_ANCHOR_ABI_VERSION);
    expect(abi.version).toBe('v1');
  });

  it('v1 uses the method names the deployed ReceiptAnchor contract exposes', () => {
    const abi = createReceiptAnchorAbi('v1');
    expect(abi.getBatchMethod).toBe('get_batch');
    expect(abi.verifyReceiptMethod).toBe('verify_receipt');
  });

  it('v1 decodes a batch return value into the stable BatchRecord shape', () => {
    const abi = createReceiptAnchorAbi('v1');
    const record = abi.decodeBatch({
      root: 'a'.repeat(64),
      count: 3,
      period_start: 100,
      period_end: 200,
    });
    expect(record).toEqual({
      root: 'a'.repeat(64),
      count: 3,
      periodStart: 100,
      periodEnd: 200,
    });
  });

  it('v1 hex-encodes a raw byte-array root', () => {
    const abi = createReceiptAnchorAbi('v1');
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const record = abi.decodeBatch({ root: bytes, count: 0, period_start: 0, period_end: 0 });
    expect(record.root).toBe('deadbeef');
  });

  it('v1 decodes verify_receipt result strictly - only `true` counts', () => {
    const abi = createReceiptAnchorAbi('v1');
    expect(abi.decodeVerifyResult(true)).toBe(true);
    expect(abi.decodeVerifyResult(false)).toBe(false);
    expect(abi.decodeVerifyResult(undefined)).toBe(false);
    expect(abi.decodeVerifyResult('true')).toBe(false);
  });

  it('throws a clear error for an unknown version', () => {
    expect(() => createReceiptAnchorAbi('v99')).toThrow(/Unknown ReceiptAnchor ABI version "v99"/);
  });

  it('lists at least the default version among known versions', () => {
    expect(listReceiptAnchorAbiVersions()).toContain(DEFAULT_RECEIPT_ANCHOR_ABI_VERSION);
  });
});

/**
 * Backwards-compatibility guarantees of the registry.
 *
 * The whole point of the registry is that two contract versions with
 * different method names and different raw field layouts both resolve to
 * the exact same BatchRecord/boolean shape on this side of the
 * abstraction - a caller (apps/web's receipt-anchor.ts) drives whichever
 * methods `abi.getBatchMethod`/`abi.verifyReceiptMethod` name, and reads
 * back a BatchRecord without knowing which version answered.
 *
 * These tests lock the property "different ABI in, identical shape out"
 * so a future version bump cannot silently leak its raw layout to callers.
 */
describe('backwards compatibility across ABI versions', () => {
  it('the built-in example legacy version uses different method names than v1', () => {
    const legacy = createReceiptAnchorAbi('v0-example');
    const current = createReceiptAnchorAbi('v1');
    expect(legacy.getBatchMethod).not.toBe(current.getBatchMethod);
    expect(legacy.verifyReceiptMethod).not.toBe(current.verifyReceiptMethod);
  });

  it('the built-in example legacy version decodes a differently-shaped raw batch to the same BatchRecord', () => {
    const legacy = createReceiptAnchorAbi('v0-example');
    const current = createReceiptAnchorAbi('v1');

    // Same underlying batch, but v0's raw layout names its fields
    // differently (`merkle_root`/`leaf_count`/`window_*` vs
    // `root`/`count`/`period_*`). Both must reshape to the stable shape.
    const legacyRaw = {
      merkle_root: 'b'.repeat(64),
      leaf_count: 5,
      window_start: 10,
      window_end: 20,
    };
    const currentRaw = { root: 'b'.repeat(64), count: 5, period_start: 10, period_end: 20 };

    expect(legacy.decodeBatch(legacyRaw)).toEqual(current.decodeBatch(currentRaw));
  });

  it('a caller can drive get_batch/verify_receipt for any registered version without knowing its shape upfront', () => {
    // Simulates what apps/web/src/lib/receipt-anchor.ts does: look up the
    // strategy once by a configured version string, then call generically.
    // This is the "one interface, many versions" property that lets callers
    // write version-agnostic code.
    function fakeContractCall(abi: ReceiptAnchorAbi, method: string): unknown {
      if (method === abi.getBatchMethod) {
        // Route by the *registered* method name so each version's wired-up
        // raw shape is exercised, exactly as the real contract client does.
        return abi === createReceiptAnchorAbi('v1')
          ? { root: 'c'.repeat(64), count: 1, period_start: 1, period_end: 2 }
          : { merkle_root: 'c'.repeat(64), leaf_count: 1, window_start: 1, window_end: 2 };
      }
      throw new Error(`unexpected method ${method}`);
    }

    for (const version of ['v1', 'v0-example']) {
      const abi = createReceiptAnchorAbi(version);
      const raw = fakeContractCall(abi, abi.getBatchMethod) as Record<string, unknown>;
      expect(abi.decodeBatch(raw)).toEqual({
        root: 'c'.repeat(64),
        count: 1,
        periodStart: 1,
        periodEnd: 2,
      });
    }
  });

  it('registerReceiptAnchorAbi lets a caller add support for a version this SDK build does not ship', () => {
    // Unknown versions fail fast by default...
    expect(() => createReceiptAnchorAbi('v2-hypothetical')).toThrow();

    // ...and the registry's open extension point lets a consumer teach the
    // SDK a future (or private) contract version at runtime, without forking.
    registerReceiptAnchorAbi({
      version: 'v2-hypothetical',
      getBatchMethod: 'get_batch_v2',
      verifyReceiptMethod: 'verify_receipt_v2',
      decodeBatch: (raw) => ({
        root: String(raw.root),
        count: Number(raw.count),
        periodStart: Number(raw.period_start),
        periodEnd: Number(raw.period_end),
      }),
      decodeVerifyResult: (raw) => raw === true,
    });

    const abi = createReceiptAnchorAbi('v2-hypothetical');
    expect(abi.getBatchMethod).toBe('get_batch_v2');
    expect(listReceiptAnchorAbiVersions()).toContain('v2-hypothetical');
  });
});
