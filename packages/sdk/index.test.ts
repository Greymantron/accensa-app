import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, verify } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import {
  SETTLEMENT_HEADER,
  SETTLE_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  attachAccensaHook,
  createSettleHook,
  reportSettlement,
  toSettleHookPayload,
  AccensaAuthError,
  AccensaError,
  AccensaNetworkError,
  type Settlement,
} from './index';

const settlement: Settlement = {
  txHash: 'a'.repeat(64),
  route: '/api/hello',
  method: 'GET',
  requestId: 'req-1',
  payer: 'G' + 'A'.repeat(55),
  amount: '1000',
  network: 'stellar:testnet',
};

/**
 * A real Ed25519 seed. `reportSettlement` signs the body with node:crypto, so
 * an arbitrary hex string would throw inside the signer and every test would
 * fail for a reason unrelated to what it is checking.
 */
const { privateKey: SIGNING_KEY, publicKey: VERIFY_KEY } = generateKeyPairSync('ed25519');
const PRIVATE_KEY_HEX = createPrivateKey().toString('hex');

function createPrivateKey(): Buffer {
  const privateKey = SIGNING_KEY;
  const der = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  // Strip the 16-byte PKCS#8 header the SDK re-adds when it rebuilds the key.
  return der.subarray(16);
}

const opts = (over: Partial<Parameters<typeof reportSettlement>[1]> = {}) => ({
  indexerUrl: 'https://accensa.test',
  privateKeyHex: PRIVATE_KEY_HEX,
  onError: vi.fn(),
  ...over,
});

const ok = () => new globalThis.Response(null, { status: 200 });

/** Typed as `fetch` itself so mock.calls carries the real init type. */
const okFetch = () => vi.fn<typeof fetch>(async () => ok());
const failingFetch = (message: string) =>
  vi.fn<typeof fetch>(async () => {
    throw new Error(message);
  });

/** The body of the nth request the mock received. */
const bodyOf = (fetchImpl: ReturnType<typeof okFetch>, n = 0) =>
  JSON.parse(fetchImpl.mock.calls[n][1]?.body as string);

/** The x402 header, as the middleware finds it: base64 JSON. */
const settleHeader = (result: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(result)).toString('base64');

/**
 * A response stand-in with just the surface the middleware touches: `finish`
 * and `getHeader`. Express's own Response is a socket away from being usable
 * in a unit test, and the middleware needs nothing else from it.
 */
function fakeRes(header?: string) {
  const res = new EventEmitter() as EventEmitter & Response;
  res.getHeader = ((name: string) =>
    name === SETTLEMENT_HEADER ? header : undefined) as Response['getHeader'];
  return res;
}

const fakeReq = (over: Partial<Request> = {}) =>
  ({ method: 'GET', path: '/api/hello', headers: {}, ...over }) as Request;

/** Runs the middleware over one request/response pair and flushes the report. */
async function runHook(
  middleware: (req: Request, res: Response, next: NextFunction) => void,
  req: Request,
  res: EventEmitter & Response,
) {
  const next = vi.fn();
  middleware(req, res, next);
  res.emit('finish');
  // reportSettlement is deliberately not awaited by the middleware.
  await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 10));
  return next;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('toSettleHookPayload', () => {
  it('maps a settlement onto the wire field names', () => {
    expect(toSettleHookPayload(settlement)).toEqual({
      tx_hash: settlement.txHash,
      route: '/api/hello',
      method: 'GET',
      request_id: 'req-1',
      payer: settlement.payer,
      amount: '1000',
      network: 'stellar:testnet',
      reported_at: expect.any(String),
    });
  });
});

describe('reportSettlement', () => {
  it('reports loudly when signing is unavailable', async () => {
    const onError = vi.fn();
    const fetchImpl = okFetch();
    const originalImport = globalThis.crypto;
    vi.stubGlobal('crypto', {
      subtle: { importKey: vi.fn().mockRejectedValue(new Error('unsupported')) },
    });
    vi.stubGlobal('process', undefined);
    vi.stubGlobal('Buffer', undefined);
    await expect(reportSettlement(settlement, opts({ fetchImpl, onError }))).resolves.toBe(false);
    expect(String(onError.mock.calls[0][0])).toContain('Ed25519 signing unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.stubGlobal('crypto', originalImport);
    vi.unstubAllGlobals();
  });

  it('posts the signed payload to the settle endpoint', async () => {
    const fetchImpl = okFetch();
    const result = await reportSettlement(settlement, opts({ fetchImpl }));

    expect(result).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://accensa.test${SETTLE_ENDPOINT}`);
    expect(init.method).toBe('POST');
    // The report is authenticated by an Ed25519 signature over the exact body
    // bytes, so the header must be present and hex — the server rejects with
    // 401 otherwise.
    const signature = (init.headers as Record<string, string>)['X-Signature'];
    expect(signature).toMatch(/^[0-9a-f]+$/);
    const body = JSON.parse(init.body as string);
    const expected = toSettleHookPayload(settlement);
    expect(body).toEqual({ ...expected, reported_at: body.reported_at });
  });

  it('does not double the slash when indexerUrl has a trailing one', async () => {
    const fetchImpl = okFetch();
    await reportSettlement(settlement, opts({ fetchImpl, indexerUrl: 'https://accensa.test/' }));
    expect(fetchImpl.mock.calls[0][0]).toBe(`https://accensa.test${SETTLE_ENDPOINT}`);
  });

  it('never logs the private key on signing failure', async () => {
    const onError = vi.fn();
    const veryBadKeyHex = 'abc';
    const fetchImpl = vi.fn();
    const options = opts({ privateKeyHex: veryBadKeyHex, onError, fetchImpl });
    await expect(reportSettlement(settlement, options)).resolves.toBe(false);

    expect(onError).toHaveBeenCalledOnce();
    const errorStr = String(onError.mock.calls[0][0]);
    expect(errorStr).not.toContain(veryBadKeyHex);

    // Also test fallback console.error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const optionsFallback = opts({ privateKeyHex: 'def', onError: undefined });
    await expect(reportSettlement(settlement, optionsFallback)).resolves.toBe(false);
    expect(String(consoleSpy.mock.calls[0][0])).not.toContain('def');
    expect(String(consoleSpy.mock.calls[0][2])).not.toContain('def');
  });

  it('reports a non-2xx response as a failure without throwing', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => new globalThis.Response(null, { status: 401 }));

    await expect(reportSettlement(settlement, opts({ fetchImpl, onError }))).resolves.toBe(false);
    const reported = onError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(AccensaAuthError);
    expect(reported).toBeInstanceOf(AccensaError);
    expect(reported).toMatchObject({ status: 401, path: SETTLE_ENDPOINT });
    expect(String(reported)).toContain('401');
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(String(onError.mock.calls[0][0])).toContain('401');
    expect(String(onError.mock.calls[0][0])).not.toContain(PRIVATE_KEY_HEX);
    // A 4xx means the request itself is wrong (#123) — it must not be retried.
    expect(fetchImpl).toHaveBeenCalledOnce();
    // The payload comes back with the error so a caller can retry or log it.
    const payload = onError.mock.calls[0][1];
    const expected = toSettleHookPayload(settlement);
    expect(payload).toEqual({ ...expected, reported_at: payload.reported_at });
  });

  it('reports a non-auth non-2xx response as a plain AccensaError', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => new globalThis.Response(null, { status: 500 }));

    await expect(reportSettlement(settlement, opts({ fetchImpl, onError }))).resolves.toBe(false);
    const reported = onError.mock.calls[0][0];
    expect(reported).toBeInstanceOf(AccensaError);
    expect(reported).not.toBeInstanceOf(AccensaAuthError);
    expect(reported).toMatchObject({ status: 500 });
  });

  it('resolves false in a runtime with no fetch at all', async () => {
    // Node 16 and some edge runtimes; the SDK must degrade rather than throw
    // a TypeError from inside a response handler.
    vi.stubGlobal('fetch', undefined);
    const onError = vi.fn();

    await expect(reportSettlement(settlement, opts({ onError }))).resolves.toBe(false);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(AccensaNetworkError);
    expect(String(onError.mock.calls[0][0])).toContain('No fetch implementation');
    vi.unstubAllGlobals();
  });

  it('wraps a rejected fetch in AccensaNetworkError with the URL and cause', async () => {
    const onError = vi.fn();
    const fetchImpl = failingFetch('ECONNREFUSED');

    await expect(reportSettlement(settlement, opts({ fetchImpl, onError }))).resolves.toBe(false);
    const reported = onError.mock.calls[0][0] as AccensaNetworkError;
    expect(reported).toBeInstanceOf(AccensaNetworkError);
    expect(reported.url).toBe(`https://accensa.test${SETTLE_ENDPOINT}`);
    expect(String(reported.cause)).toContain('ECONNREFUSED');
  });

  it('uses global fetch when no implementation is injected', async () => {
    const spy = okFetch();
    vi.stubGlobal('fetch', spy);

    await expect(reportSettlement(settlement, opts())).resolves.toBe(true);
    expect(spy).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  it('falls back to console.error when no onError is supplied', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(
      reportSettlement(settlement, {
        indexerUrl: 'https://accensa.test',
        privateKeyHex: PRIVATE_KEY_HEX,
        fetchImpl,
        // Not testing retry behaviour here — keep it to one attempt so this
        // stays fast.
        retry: { maxRetries: 0 },
      }),
    ).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();
  });
});

describe('reportSettlement — retry (#123)', () => {
  it('retries a transient 5xx from the indexer and succeeds once it recovers', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockResolvedValueOnce(new globalThis.Response(null, { status: 503 }));
    fetchImpl.mockResolvedValueOnce(new globalThis.Response(null, { status: 504 }));
    fetchImpl.mockResolvedValueOnce(ok());

    const onError = vi.fn();
    const result = await reportSettlement(
      settlement,
      opts({ fetchImpl, onError, retry: { baseDelayMs: 1 } }),
    );

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onError).not.toHaveBeenCalled();
  });

  it('gives up and reports failure after exhausting retries against a persistent 503', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new globalThis.Response(null, { status: 503 }),
    );
    const onError = vi.fn();

    const result = await reportSettlement(
      settlement,
      opts({ fetchImpl, onError, retry: { baseDelayMs: 1, maxRetries: 3 } }),
    );

    expect(result).toBe(false);
    // The initial attempt plus 3 retries.
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(String(onError.mock.calls[0][0])).toContain('503');
  });

  it('retries a dropped connection the same way as a 5xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    fetchImpl.mockRejectedValueOnce(new Error('ECONNRESET'));
    fetchImpl.mockResolvedValueOnce(ok());

    const result = await reportSettlement(
      settlement,
      opts({ fetchImpl, retry: { baseDelayMs: 1 } }),
    );

    expect(result).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('respects a custom maxRetries', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new globalThis.Response(null, { status: 503 }),
    );

    await reportSettlement(
      settlement,
      opts({ fetchImpl, retry: { baseDelayMs: 1, maxRetries: 1 } }),
    );

    // The initial attempt plus 1 retry, not the default 3.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('reportSettlement — network timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that never answers, exactly like a dropped connection. */
  const hangingFetch = () =>
    vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<globalThis.Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    );

  it('aborts and resolves false rather than rejecting', async () => {
    const onError = vi.fn();
    const fetchImpl = hangingFetch();

    // The regression this guards: an un-awaited rejection here crashes the
    // seller's process under Node's default unhandledRejection behaviour.
    const result = await reportSettlement(settlement, opts({ fetchImpl, onError, timeoutMs: 10 }));

    expect(result).toBe(false);
    expect(onError).toHaveBeenCalledOnce();
    // The abort surfaces as a network error carrying the AbortError as cause.
    const reported = onError.mock.calls[0][0] as AccensaNetworkError;
    expect(reported).toBeInstanceOf(AccensaNetworkError);
    expect(reported.cause).toBeInstanceOf(DOMException);
    expect((reported.cause as DOMException).name).toBe('AbortError');
  });

  it('passes an abort signal to fetch', async () => {
    const fetchImpl = hangingFetch();
    await reportSettlement(settlement, opts({ fetchImpl, timeoutMs: 5, onError: vi.fn() }));
    expect(fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to a five second timeout', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const fetchImpl = hangingFetch();

    // Replace WebCrypto with promise-only operations so signing resolves on the
    // microtask queue. A real importKey/sign completes on the libuv threadpool,
    // letting the fake-timer abort outpace the fetch registration and leave the
    // abort listener attached to an already-aborted signal.
    const subtle = {
      importKey: vi.fn(async () => ({})),
      sign: vi.fn(async () => new Uint8Array(64)),
    };
    vi.stubGlobal('crypto', { subtle });
    try {
      const pending = reportSettlement(settlement, opts({ fetchImpl, onError }));
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1);
      expect(onError).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(false);
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  }, 10_000);

  it('clears the timer once the request succeeds, leaving nothing pending', async () => {
    vi.useFakeTimers();
    const fetchImpl = okFetch();

    await expect(reportSettlement(settlement, opts({ fetchImpl }))).resolves.toBe(true);
    // A live 5s timer would keep a short-lived process alive after its work.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('attachAccensaHook', () => {
  const paid = settleHeader({
    success: true,
    transaction: settlement.txHash,
    network: 'stellar:testnet',
    payer: settlement.payer,
    amount: '1000',
  });

  it('reports the settlement once the response finishes', async () => {
    const fetchImpl = okFetch();
    const next = await runHook(
      attachAccensaHook(opts({ fetchImpl })),
      fakeReq({ headers: { 'x-request-id': 'req-1' } }),
      fakeRes(paid),
    );

    expect(next).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(bodyOf(fetchImpl)).toMatchObject({
      tx_hash: settlement.txHash,
      route: '/api/hello',
      method: 'GET',
      request_id: 'req-1',
    });
  });

  it('prefers the route template over the literal path', async () => {
    // Attributing to req.path would turn one paid endpoint into a route per id.
    const fetchImpl = okFetch();
    await runHook(
      attachAccensaHook(opts({ fetchImpl })),
      fakeReq({ path: '/api/quote/abc123', route: { path: '/api/quote/:id' } as Request['route'] }),
      fakeRes(paid),
    );

    expect(bodyOf(fetchImpl).route).toBe('/api/quote/:id');
  });

  it('ignores a request with no settlement header', async () => {
    const fetchImpl = okFetch();
    const next = await runHook(attachAccensaHook(opts({ fetchImpl })), fakeReq(), fakeRes());

    expect(next).toHaveBeenCalledOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-base64 header', 'not base64 at all!!'],
    ['a header that is not JSON', Buffer.from('nope').toString('base64')],
    ['a failed settlement', settleHeader({ success: false, transaction: '' })],
    ['a success with no transaction hash', settleHeader({ success: true, transaction: '' })],
  ])('does not report for %s', async (_label, header) => {
    const fetchImpl = okFetch();
    await runHook(attachAccensaHook(opts({ fetchImpl })), fakeReq(), fakeRes(header));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('calls next() synchronously, before anything is reported', () => {
    const next = vi.fn();
    attachAccensaHook(opts({ fetchImpl: okFetch() }))(fakeReq(), fakeRes(paid), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('never breaks the response when reporting throws', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error('network is down');
    });

    const next = await runHook(
      // Not testing retry behaviour here — one attempt keeps this in step
      // with runHook's single setImmediate tick.
      attachAccensaHook(opts({ fetchImpl, onError, retry: { maxRetries: 0 } })),
      fakeReq(),
      fakeRes(paid),
    );

    expect(next).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it('survives an attribute callback that throws', async () => {
    // A custom router accessor is caller code; a bug in it must not surface as
    // an uncaught exception on a response that has already been sent.
    const onError = vi.fn();
    const fetchImpl = okFetch();
    const middleware = attachAccensaHook({
      ...opts({ fetchImpl, onError }),
      attribute: () => {
        throw new Error('bad router');
      },
    });

    expect(() => runHook(middleware, fakeReq(), fakeRes(paid))).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(onError).toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses a caller-supplied attribute callback', async () => {
    const fetchImpl = okFetch();
    const middleware = attachAccensaHook<Request & { routeTemplate: string }>({
      ...opts({ fetchImpl }),
      attribute: (req) => ({ route: req.routeTemplate, method: 'POST', requestId: 'custom' }),
    });

    const req = fakeReq() as Request & { routeTemplate: string };
    req.routeTemplate = '/v1/quotes/:id';
    await runHook(
      middleware as typeof middleware & Parameters<typeof runHook>[0],
      req,
      fakeRes(paid),
    );

    expect(bodyOf(fetchImpl)).toMatchObject({
      route: '/v1/quotes/:id',
      method: 'POST',
      request_id: 'custom',
    });
  });
});

/*
 * Coverage for the paths the suites above leave open.
 *
 * Strategy: every test drives the public exports through an injected
 * `fetchImpl` and `onError`, so nothing touches the network and every failure
 * is observed exactly as a merchant would see it — as a resolved `false` plus
 * one `onError` call, never a throw. Signing runs against a real Ed25519 key
 * so the wire format is checked end to end, not against a mocked signer.
 */

describe('reportSettlement — signing and headers', () => {
  it('signs the exact body bytes with the configured key', async () => {
    // A hex-shaped header proves nothing on its own; the indexer checks the
    // signature against the merchant's public key, so this test does too.
    const fetchImpl = okFetch();
    await reportSettlement(settlement, opts({ fetchImpl }));

    const init = fetchImpl.mock.calls[0][1]!;
    const signature = (init.headers as Record<string, string>)['X-Signature'];
    expect(
      verify(null, Buffer.from(init.body as string), VERIFY_KEY, Buffer.from(signature, 'hex')),
    ).toBe(true);
  });

  it('sends X-Key-Id when a keyId is configured', async () => {
    const fetchImpl = okFetch();
    await reportSettlement(settlement, opts({ fetchImpl, keyId: 'key-2026' }));
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers['X-Key-Id']).toBe('key-2026');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('omits X-Key-Id entirely when no keyId is configured', async () => {
    const fetchImpl = okFetch();
    await reportSettlement(settlement, opts({ fetchImpl }));
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('X-Key-Id');
  });

  it('reports a malformed key as an error with the payload, before any fetch', async () => {
    const onError = vi.fn();
    const fetchImpl = okFetch();
    await expect(
      reportSettlement(settlement, opts({ fetchImpl, onError, privateKeyHex: 'zz'.repeat(32) })),
    ).resolves.toBe(false);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(String(onError.mock.calls[0][0])).toContain('exactly 32 bytes');
    expect(onError.mock.calls[0][1]).toMatchObject({ tx_hash: settlement.txHash });
  });

  it('passes the undelivered payload along with a network error', async () => {
    const onError = vi.fn();
    await reportSettlement(
      settlement,
      opts({ fetchImpl: failingFetch('ECONNRESET'), onError, retry: { maxRetries: 0 } }),
    );
    expect(onError.mock.calls[0][1]).toMatchObject({ tx_hash: settlement.txHash });
  });

  it('reports 403 as an auth error, like 401', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => new globalThis.Response(null, { status: 403 }));
    await reportSettlement(settlement, opts({ fetchImpl, onError }));
    expect(onError.mock.calls[0][0]).toBeInstanceOf(AccensaAuthError);
    expect(onError.mock.calls[0][0]).toMatchObject({ status: 403, path: SETTLE_ENDPOINT });
  });

  it('wraps a non-Error rejection with its string form as the cause text', async () => {
    const onError = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.reject('socket hang up'));
    await reportSettlement(settlement, opts({ fetchImpl, onError, retry: { maxRetries: 0 } }));
    const reported = onError.mock.calls[0][0] as AccensaNetworkError;
    expect(reported).toBeInstanceOf(AccensaNetworkError);
    expect(reported.message).toContain('socket hang up');
  });
});

describe('toSettleHookPayload — optional fields', () => {
  it('leaves absent optional fields undefined rather than inventing them', () => {
    const payload = toSettleHookPayload({ txHash: 'b'.repeat(64), route: '/r', method: 'POST' });
    expect(payload).toMatchObject({ tx_hash: 'b'.repeat(64), route: '/r', method: 'POST' });
    expect(payload.request_id).toBeUndefined();
    expect(payload.payer).toBeUndefined();
    expect(payload.amount).toBeUndefined();
    expect(payload.network).toBeUndefined();
  });

  it('stamps reported_at with the current time in ISO 8601', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-02T03:04:05.000Z'));
    expect(toSettleHookPayload(settlement).reported_at).toBe('2026-01-02T03:04:05.000Z');
  });
});

describe('attachAccensaHook — default attribution', () => {
  const paid = settleHeader({ success: true, transaction: settlement.txHash });

  it('takes the first x-request-id when the header repeats', async () => {
    const fetchImpl = okFetch();
    await runHook(
      attachAccensaHook(opts({ fetchImpl })),
      fakeReq({ headers: { 'x-request-id': ['first', 'second'] } }),
      fakeRes(paid),
    );
    expect(bodyOf(fetchImpl).request_id).toBe('first');
  });

  it('omits request_id when no x-request-id header is sent', async () => {
    const fetchImpl = okFetch();
    await runHook(attachAccensaHook(opts({ fetchImpl })), fakeReq(), fakeRes(paid));
    expect(bodyOf(fetchImpl)).not.toHaveProperty('request_id');
  });

  it('tolerates a request with no headers object at all', async () => {
    const fetchImpl = okFetch();
    await runHook(
      attachAccensaHook(opts({ fetchImpl })),
      { method: 'GET', path: '/api/hello' } as Request,
      fakeRes(paid),
    );
    expect(bodyOf(fetchImpl).route).toBe('/api/hello');
  });

  it.each([
    ['no path or route', { method: 'GET', path: undefined }],
    ['no method', { method: undefined }],
  ])('does not report a request with %s', async (_label, over) => {
    // Attribution to an empty route or verb would be a row nobody can act on.
    const fetchImpl = okFetch();
    await runHook(
      attachAccensaHook(opts({ fetchImpl })),
      fakeReq(over as Partial<Request>),
      fakeRes(paid),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ignores a settlement header that is not a single string', async () => {
    // getHeader can return an array or a number when something upstream set
    // it oddly; neither is a valid x402 settlement.
    for (const header of [[paid], 42]) {
      const fetchImpl = okFetch();
      const res = new EventEmitter() as EventEmitter & Response;
      res.getHeader = (() => header) as Response['getHeader'];
      await runHook(attachAccensaHook(opts({ fetchImpl })), fakeReq(), res);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });

  it('logs to console.error when attribute throws and no onError is set', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const middleware = attachAccensaHook({
      indexerUrl: 'https://accensa.test',
      privateKeyHex: PRIVATE_KEY_HEX,
      fetchImpl: okFetch(),
      attribute: () => {
        throw new Error('bad router');
      },
    });
    await runHook(middleware, fakeReq(), fakeRes(paid));
    expect(spy).toHaveBeenCalledWith(
      '[accensa] could not report settlement',
      '',
      expect.objectContaining({ message: 'bad router' }),
    );
  });

  it('reports nothing until the response finishes', () => {
    const fetchImpl = okFetch();
    attachAccensaHook(opts({ fetchImpl }))(fakeReq(), fakeRes(paid), vi.fn());
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createSettleHook', () => {
  const result = {
    success: true,
    transaction: settlement.txHash,
    network: 'stellar:testnet',
    payer: settlement.payer,
    amount: '1000',
  };
  const resource = (url?: string) => ({ resource: { url } });

  it('reports the settle result attributed to the resource path', async () => {
    const fetchImpl = okFetch();
    await createSettleHook(opts({ fetchImpl }))({
      result,
      paymentPayload: resource('https://merchant.test/api/quote?x=1'),
    });

    // onAfterSettle awaits the report, so there is nothing left to flush.
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(bodyOf(fetchImpl)).toMatchObject({
      tx_hash: settlement.txHash,
      route: '/api/quote',
      method: 'GET',
      payer: settlement.payer,
      amount: '1000',
      network: 'stellar:testnet',
    });
  });

  it('attributes to the configured method, normalised to upper case', async () => {
    const fetchImpl = okFetch();
    await createSettleHook({ ...opts({ fetchImpl }), method: 'post' })({
      result,
      paymentPayload: resource('/api/quote'),
    });
    expect(bodyOf(fetchImpl).method).toBe('POST');
  });

  it.each([
    ['a failed settlement', { ...result, success: false }],
    ['a settlement with no transaction hash', { ...result, transaction: '  ' }],
  ])('does not report %s', async (_label, failed) => {
    const fetchImpl = okFetch();
    await createSettleHook(opts({ fetchImpl }))({
      result: failed,
      paymentPayload: resource('/api/quote'),
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['no payment payload', undefined],
    ['no resource URL', resource(undefined)],
    ['a resource that is neither a URL nor a path', resource('not a url')],
  ])('does not report when there is %s to attribute to', async (_label, paymentPayload) => {
    const fetchImpl = okFetch();
    await createSettleHook(opts({ fetchImpl }))({ result, paymentPayload });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves rather than rejecting when the report fails', async () => {
    // onAfterSettle runs inside the x402 server's settle path; a rejection
    // there would fail a payment that has already gone through.
    const onError = vi.fn();
    await expect(
      createSettleHook(
        opts({ fetchImpl: failingFetch('ECONNREFUSED'), onError, retry: { maxRetries: 0 } }),
      )({ result, paymentPayload: resource('/api/quote') }),
    ).resolves.toBeUndefined();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(AccensaNetworkError);
  });
});
