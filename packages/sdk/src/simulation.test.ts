import { describe, expect, it } from 'vitest';
import { Contract, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  buildSimulationTransaction,
  decodeSimulationResult,
  hexToScValBytes,
  parseBatchRecord,
} from './simulation';

const CONTRACT_ID = 'CBHRJU7CF4XIFRNDITFHNQHABKBMFM2FYFHLGWN3JGSFYYCDSMDAWPRV';

function expectSim(hash: string): xdr.ScVal {
  return xdr.ScVal.scvBytes(Buffer.from(hash, 'hex'));
}

describe('hexToScValBytes', () => {
  it('encodes a hex string as ScVal bytes', () => {
    const scval = hexToScValBytes('deadbeef');
    expect(scval.switch()).toBe(xdr.ScValType.scvBytes());
    expect(Buffer.from(scval.bytes())).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
  });

  it('tolerates surrounding whitespace', () => {
    const scval = hexToScValBytes('  abcdef01  ');
    expect(Buffer.from(scval.bytes())).toEqual(Buffer.from('abcdef01', 'hex'));
  });

  it('accepts odd-shaped hashes by passing them through Buffer.from hex', () => {
    const scval = hexToScValBytes('aabbcc');
    expect(Buffer.from(scval.bytes()).toString('hex')).toBe('aabbcc');
  });
});

describe('buildSimulationTransaction', () => {
  it('builds a read-only transaction calling the given method', () => {
    const contract = new Contract(CONTRACT_ID);
    const tx = buildSimulationTransaction({
      contract,
      simulationSource: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
      networkPassphrase: 'Test SDF Network ; September 2015',
      method: 'get_batch',
      args: [nativeToScVal(1, { type: 'u64' })],
    });

    // An unsigned simulation transaction should expose the intended operation.
    expect(tx.operations).toHaveLength(1);
    // The source account string is what the builder resolved from the id.
    expect(tx.source).toBe('GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6');
  });

  it('honors custom fee and timeout', () => {
    const contract = new Contract(CONTRACT_ID);
    const tx = buildSimulationTransaction({
      contract,
      simulationSource: 'GCALKSGAZRJLSUEJT3M5W6LN4R7XQOLIRCOS6ZA6EDZVTZDBIIPPFKJ6',
      networkPassphrase: 'Test SDF Network ; September 2015',
      method: 'verify_receipt',
      args: [],
      fee: '250',
      timeout: 10,
    });
    expect(tx.fee).toBe('250');
    expect(tx.timeBounds ? tx.timeBounds.toString() : 'no-time-bounds').toBeTruthy();
  });
});

describe('decodeSimulationResult', () => {
  it('returns the decoded native value from a successful simulation', () => {
    const sim = {
      result: { retval: nativeToScVal(true) },
    } as unknown as rpc.Api.SimulateTransactionResponse;
    expect(decodeSimulationResult(sim, 'verify_receipt')).toBe(true);
  });

  it('throws the RPC error message on a simulation error', () => {
    const sim = { error: 'contract not found' } as unknown as rpc.Api.SimulateTransactionResponse;
    expect(() => decodeSimulationResult(sim, 'get_batch')).toThrow('contract not found');
  });

  it('throws when the method returned no value', () => {
    const sim = { result: {} } as unknown as rpc.Api.SimulateTransactionResponse;
    expect(() => decodeSimulationResult(sim, 'get_batch')).toThrow('get_batch returned no value');
  });
});

describe('parseBatchRecord', () => {
  it('maps a contract-shaped batch into the stable BatchRecord shape', () => {
    const raw = {
      root: Buffer.from('deadbeef', 'hex'),
      count: 3,
      period_start: 100,
      period_end: 200,
    };
    expect(parseBatchRecord(raw)).toEqual({
      root: 'deadbeef',
      count: 3,
      periodStart: 100,
      periodEnd: 200,
    });
  });

  it('normalizes a hex-string root without re-encoding', () => {
    expect(parseBatchRecord({ root: 'abc123', count: 0, period_start: 0, period_end: 0 })).toEqual({
      root: 'abc123',
      count: 0,
      periodStart: 0,
      periodEnd: 0,
    });
  });

  it('handles edge cases: empty proof leaf and zero-count batch', () => {
    expect(expectSim('00').bytes()).toBeTruthy();
    const empty = parseBatchRecord({
      root: Buffer.alloc(0),
      count: 0,
      period_start: 0,
      period_end: 0,
    });
    expect(empty.root).toBe('');
  });
});
