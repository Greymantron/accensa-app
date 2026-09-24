/**
 * Cost of one read-only `ReceiptAnchor` simulation, and the allocation
 * savings of the SDK's hex-decoding cache.
 *
 * `pnpm vitest bench src/receipt-anchor-client.bench.ts`. Measures
 * client-side work only (transaction build + argument ScVal encoding +
 * contract decode) against a fake RPC server, so the numbers reflect pure
 * allocation/compute cost, not network jitter.
 *
 * The client memoizes leaf/proof hex decoding (bounded cache in
 * `src/simulation.ts`), so verifying the *same* receipt repeatedly skips
 * re-allocating Buffers and xdr values on every call — a common pattern for
 * a merchant re-checking or an agent polling a batch. "same receipt
 * repeatedly" exercises the cache-hit steady state; "unique receipt each
 * call" reproduces the pre-optimization all-miss cost.
 */
import { bench, describe } from 'vitest';
import { nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import { ReceiptAnchorClient, type RpcServerLike } from '../receipt-anchor-client';

const LEAF = 'a'.repeat(64);
const PROOF = ['b'.repeat(64)];

function fakeServer(retval: xdr.ScVal): RpcServerLike {
  return {
    simulateTransaction: (async () =>
      ({ result: { retval } }) as unknown as ReturnType<
        InstanceType<typeof rpc.Server>['simulateTransaction']
      >) as RpcServerLike['simulateTransaction'],
  };
}

// Warm client: reuses the same parsed Contract across every iteration.
const warm = new ReceiptAnchorClient({ rpcServerFactory: () => fakeServer(nativeToScVal(true)) });

// Monotonic counter defeat the memoization for the "unique" benchmark the
// way a real flood of distinct receipts would.
let nonce = 0;

describe('ReceiptAnchorClient#verifyReceiptOnChain', () => {
  bench(
    'same receipt repeatedly (leaf/proof decoded once, memoized)',
    async () => {
      await warm.verifyReceiptOnChain(1, LEAF, PROOF);
    },
    { time: 200, iterations: 100 },
  );

  // A fresh leaf every iteration defeats the memoization, reproducing the
  // pre-optimization cost of re-allocating Buffers for every verification.
  bench(
    'unique receipt each call (no memoization hit)',
    async () => {
      nonce += 1;
      await warm.verifyReceiptOnChain(1, nonce.toString(16).padStart(64, '0'), PROOF);
    },
    { time: 200, iterations: 100 },
  );
});

describe('ReceiptAnchorClient#getBatch', () => {
  const batchRetval = nativeToScVal({
    root: Buffer.from('c'.repeat(64), 'hex'),
    count: 3,
    period_start: 100,
    period_end: 200,
  });
  const batchClient = new ReceiptAnchorClient({ rpcServerFactory: () => fakeServer(batchRetval) });

  bench(
    'getBatch (stable batch shape)',
    async () => {
      await batchClient.getBatch(1);
    },
    { time: 200, iterations: 100 },
  );
});
