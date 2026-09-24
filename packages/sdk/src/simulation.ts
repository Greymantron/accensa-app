import {
  Account,
  Contract,
  TransactionBuilder,
  type Transaction,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

/** Shape of the raw `get_batch` return value before it is reshaped. */
export type RawBatch = Record<string, unknown>;

/** Inputs required to build one read-only Soroban simulation transaction. */
export interface SimulationTransactionInput {
  contract: Contract;
  simulationSource: string;
  networkPassphrase: string;
  method: string;
  args: xdr.ScVal[];
  fee?: string;
  timeout?: number;
}

/**
 * Decodes a hex string into a ScVal bytes value.
 *
 * Leading/trailing whitespace is tolerated so callers can pass hex straight
 * from user input or logs without an extra `trim()`.
 *
 * Results are memoized (bounded cache): when a merchant verifies the same
 * receipt more than once — a retry, a dashboard re-check, an agent polling a
 * batch — the leaf and proof nodes hit the cache and skip allocating fresh
 * `Buffer`s and xdr objects on every call.
 */
const HEX_BYTES_CACHE_LIMIT = 256;
const hexBytesCache = new Map<string, xdr.ScVal>();

export function hexToScValBytes(hex: string): xdr.ScVal {
  const key = hex.trim();
  const cached = hexBytesCache.get(key);
  if (cached) return cached;
  const value = xdr.ScVal.scvBytes(Buffer.from(key, 'hex'));
  if (hexBytesCache.size >= HEX_BYTES_CACHE_LIMIT) {
    const oldest = hexBytesCache.keys().next().value;
    if (oldest !== undefined) hexBytesCache.delete(oldest);
  }
  hexBytesCache.set(key, value);
  return value;
}

/**
 * Builds a fee-less, read-only Soroban simulation transaction.
 *
 * The returned transaction is never signed or submitted: it exists only to
 * let an RPC server run `contract.call(method, ...args)` against the current
 * ledger state and return the simulated result. The source account exists
 * purely to satisfy the transaction format and is never charged a balance.
 */
export function buildSimulationTransaction({
  contract,
  simulationSource,
  networkPassphrase,
  method,
  args,
  fee = '100',
  timeout = 30,
}: SimulationTransactionInput): Transaction {
  const source = new Account(simulationSource, '0');
  const options = { fee, networkPassphrase };
  return new TransactionBuilder(source, options)
    .addOperation(contract.call(method, ...args))
    .setTimeout(timeout)
    .build();
}

/**
 * Normalizes an RPC simulation response into a plain-JS value.
 *
 * Throws when the RPC reported a simulation error (e.g. the contract panicked
 * or the batch does not exist) and when the method returned no value at all,
 * so callers never have to inspect the raw xdr envelope themselves.
 */
export function decodeSimulationResult(
  sim: rpc.Api.SimulateTransactionResponse,
  method: string,
): unknown {
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(sim.error);
  }
  if (!('result' in sim) || !sim.result?.retval) {
    throw new Error(`${method} returned no value`);
  }
  return scValToNative(sim.result.retval);
}

/**
 * Reshapes a contract's raw `get_batch` return value into the stable
 * `BatchRecord` shape. The contract returns a hex string or byte array for
 * `root`; both normalize to the same lowercase hex string.
 */
export function parseBatchRecord(raw: RawBatch): {
  root: string;
  count: number;
  periodStart: number;
  periodEnd: number;
} {
  const root = raw.root;
  return {
    root:
      typeof root === 'string'
        ? root
        : Buffer.isBuffer(root)
          ? root.toString('hex')
          : Buffer.from(root as Uint8Array).toString('hex'),
    count: Number(raw.count),
    periodStart: Number(raw.period_start),
    periodEnd: Number(raw.period_end),
  };
}
