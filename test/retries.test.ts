import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, ConflictError, EtchvTimeoutError, ServiceUnavailableError } from '../src/index.js';

const id = 'ab'.repeat(32);
const asset = 'ast_' + 'a'.repeat(64);
const delivery = 'std_' + 'd'.repeat(64);
const png = new Uint8Array(300); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
const detected = { watermarked: true, confidence: 0.99, watermark_id: id };

type Init = RequestInit & { body?: any; headers?: any };
type Handler = (url: URL, init: Init) => Response | Promise<Response>;
const client = (handler: Handler, options: { timeout?: number; largeFileThreshold?: number } = {}) => new Etchv({ apiKey: 'test-key', ...options,
  fetch: ((url: string | URL, init: Init) => handler(new URL(String(url)), init)) as unknown as typeof fetch });
const conflict = (code: string, headers: Record<string, string> = {}) =>
  Response.json({ detail: { code, message: code } }, { status: 409, headers });

// Run short waits (retry pauses) at once and record them; request deadlines stay real.
function fastWaits(t: TestContext) {
  const waits: number[] = [];
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms = 0) => {
    if (ms >= 60_000) return real(fn, ms);
    waits.push(ms);
    return real(fn, 0);
  });
  return waits;
}

test('instant detection resends a dropped connection with the same generated key', async (t) => {
  fastWaits(t);
  for (const detect of ['detectImage', 'detectDocument'] as const) {
    const keys: string[] = [];
    const sdk = client((_url, init) => {
      keys.push(init.headers['Idempotency-Key']);
      if (keys.length === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      return Response.json(detected, { headers: { 'x-request-id': 'req_1', 'idempotent-replayed': 'true' } });
    });
    assert.equal((await sdk[detect](png)).watermarkId, id);
    assert.equal(keys.length, 2);
    assert.match(keys[0], /^[0-9a-f-]{36}$/);
    assert.equal(keys[0], keys[1]);
  }
  const given: string[] = [];
  const sdk = client((_url, init) => {
    given.push(init.headers['Idempotency-Key']);
    if (given.length === 1) throw new TypeError('fetch failed');
    return Response.json(detected);
  });
  await sdk.detectImage(png, { idempotencyKey: 'scan-0001' });
  assert.deepEqual(given, ['scan-0001', 'scan-0001']);
});

test('request_in_progress waits for Retry-After, capped at 5 seconds, and sends again', async (t) => {
  const waits = fastWaits(t);
  const responses = [() => conflict('request_in_progress', { 'retry-after': '2' }),
    () => conflict('request_in_progress', { 'retry-after': '600' }), () => Response.json(detected)];
  assert.equal((await client(() => responses.shift()!()).detectImage(png)).watermarked, true);
  assert.deepEqual(waits, [2000, 5000]);
});

test('replay_expired and request_failed reject with ConflictError without retrying', async () => {
  for (const code of ['replay_expired', 'request_failed']) {
    const keys: string[] = [];
    const sdk = client((_url, init) => { keys.push(init.headers['Idempotency-Key']); return conflict(code); });
    await assert.rejects(sdk.detectDocument(png), (error: any) =>
      error instanceof ConflictError && error.code === code && error.idempotencyKey === keys[0]);
    assert.equal(keys.length, 1);
  }
  let calls = 0;
  const busy = client(() => { calls += 1; return Response.json({ detail: 'busy' }, { status: 503 }); });
  await assert.rejects(busy.detectImage(png), ServiceUnavailableError);
  assert.equal(calls, 1);
});

test('running out of time reports the detection key', async (t) => {
  fastWaits(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 50_000));
  const sdk = client(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(sdk.detectImage(png, { idempotencyKey: 'scan-0002' }), (error: any) =>
    error instanceof EtchvTimeoutError && error.detail.idempotencyKey === 'scan-0002' && error.idempotencyKey === 'scan-0002');
});

test('keepResult is sent as the keep_result query parameter', async () => {
  const queries: string[] = [];
  const sdk = client((url) => { queries.push(url.search); return Response.json(detected); });
  await sdk.detectImage(png);
  await sdk.detectImage(png, { keepResult: false });
  await sdk.detectDocument(png, { keepResult: true, accelerator: 'gpu' });
  assert.deepEqual(queries, ['', '?keep_result=false', '?keep_result=true&accelerator=gpu']);
  await assert.rejects(sdk.detectImage(png, { keepResult: 'no' as any }), /keepResult must be a boolean/);
  await assert.rejects(sdk.detectVideo(png, { keepResult: false } as any), /image and document detection only/);
});

test('a consumed upload is uploaded again and resent with the same key', async (t) => {
  fastWaits(t);
  const ids = ['upl_' + '1'.repeat(32), 'upl_' + '2'.repeat(32)];
  const posts: [string, string][] = [];
  const sdk = client(async (url, init) => {
    if (url.pathname === '/uploads') {
      const uploadId = ids.shift()!;
      return Response.json({ upload_id: uploadId, kind: 'detect', status: 'pending',
        upload: { method: 'PUT', url: `https://uploads.etchv.com/detect/${uploadId}.png` } }, { status: 201 });
    }
    if (url.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    posts.push([init.headers['Idempotency-Key'], String(init.body.get('upload_id'))]);
    if (posts.length === 1) throw new TypeError('fetch failed');
    if (posts.length === 2) return conflict('upload_consumed');
    return Response.json(detected);
  }, { largeFileThreshold: 100 });
  await sdk.detectImage(png, { keepResult: false });
  const key = posts[0][0];
  assert.deepEqual(posts, [[key, 'upl_' + '1'.repeat(32)], [key, 'upl_' + '1'.repeat(32)], [key, 'upl_' + '2'.repeat(32)]]);

  // Embedding never re-uploads: its replay returns the job.
  let uploads = 0;
  const embed = client((url) => {
    if (url.pathname === '/uploads') {
      uploads += 1;
      return Response.json({ upload_id: ids[0] ?? 'upl_' + '3'.repeat(32), upload: { method: 'PUT', url: 'https://uploads.etchv.com/image/x.png' } }, { status: 201 });
    }
    if (url.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    return conflict('upload_consumed');
  }, { largeFileThreshold: 100 });
  await assert.rejects(embed.embedImage(png, { recipient: 'a' }), ConflictError);
  assert.equal(uploads, 1);
});

const uploadSession = (url: URL) => url.pathname === '/uploads'
  ? Response.json({ upload_id: 'upl_' + '1'.repeat(32), upload: { method: 'PUT', url: 'https://uploads.etchv.com/detect/x.png' } }, { status: 201 })
  : url.host === 'uploads.etchv.com' ? new Response(null, { status: 200 }) : null;

test('a resend that finds the first copy still using the upload waits and sends again', async (t) => {
  const waits = fastWaits(t);
  let uploads = 0;
  const posts: [string, string][] = [];
  const sdk = client((url, init) => {
    if (url.pathname === '/uploads') uploads += 1;
    const session = uploadSession(url);
    if (session) return session;
    posts.push([init.headers['Idempotency-Key'], String(init.body.get('upload_id'))]);
    if (posts.length === 1) throw new TypeError('fetch failed', { cause: new Error('Server disconnected without sending a response.') });
    if (posts.length === 2) return conflict('upload_in_use');
    return Response.json(detected);
  }, { largeFileThreshold: 100 });
  assert.equal((await sdk.detectImage(png)).watermarked, true);
  assert.equal(uploads, 1);
  assert.equal(posts.length, 3);
  assert.equal(new Set(posts.map(post => post.join())).size, 1);
  assert.deepEqual(waits, [1000, 1000]);
});

test('upload_in_use for a file in the request body is not waited for and carries the key', async () => {
  let calls = 0;
  const sdk = client(() => { calls += 1; return conflict('upload_in_use'); });
  await assert.rejects(sdk.detectImage(png), (error: any) =>
    error instanceof ConflictError && /^[0-9a-f-]{36}$/.test(error.idempotencyKey));
  assert.equal(calls, 1);
});

test('the resend after a new upload keeps the first deadline', async (t) => {
  fastWaits(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const posts: string[] = [];
  const sdk = client((url, init) => {
    const session = uploadSession(url);
    if (session) return session;
    posts.push(init.headers['Idempotency-Key']);
    now += 121_000; // The first send used up the 120 s client timeout.
    return conflict('upload_consumed');
  }, { largeFileThreshold: 100 });
  await assert.rejects(sdk.detectImage(png, { idempotencyKey: 'scan-0004' }), (error: any) =>
    error instanceof EtchvTimeoutError && error.idempotencyKey === 'scan-0004');
  assert.deepEqual(posts, ['scan-0004']);
});

test('a failed new upload carries the key, network errors included', async (t) => {
  fastWaits(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const failing of ['session', 'put'] as const) {
    let uploads = 0, puts = 0;
    const keys: string[] = [];
    const sdk = client((url, init) => {
      if (url.pathname === '/uploads' && (uploads += 1) === 2 && failing === 'session') throw new TypeError('fetch failed');
      if (url.host === 'uploads.etchv.com' && (puts += 1) > 1 && failing === 'put') {
        now += 10_000; // The new upload keeps failing until its own deadline passes.
        throw new TypeError('fetch failed');
      }
      const session = uploadSession(url);
      if (session) return session;
      keys.push(init.headers['Idempotency-Key']);
      if (keys.length === 1) throw new TypeError('fetch failed', { cause: new Error('ECONNRESET') });
      return conflict('upload_consumed');
    }, { largeFileThreshold: 100 });
    await assert.rejects(sdk.detectImage(png, { keepResult: false }), (error: any) =>
      (failing === 'session' ? error instanceof TypeError : error instanceof EtchvTimeoutError) && error.idempotencyKey === keys[0]);
    assert.equal(keys.length, 2);
  }
});

test('downloads retry a dropped connection but no error status', async (t) => {
  fastWaits(t);
  for (const [path, download, identifier] of [[`/assets/${asset}/content`, 'downloadAsset', asset],
    [`/storage/deliveries/${delivery}/content`, 'downloadStorageDelivery', delivery]] as const) {
    const calls: string[] = [];
    const sdk = client((url) => {
      calls.push(url.pathname);
      if (calls.length === 1) throw new TypeError('fetch failed');
      return new Response('file');
    });
    assert.deepEqual(await sdk[download](identifier), new TextEncoder().encode('file'));
    assert.deepEqual(calls, [path, path]);
  }
  let calls = 0;
  const busy = client(() => { calls += 1; return Response.json({ detail: 'busy' }, { status: 503 }); });
  await assert.rejects(busy.downloadAsset(asset), ServiceUnavailableError);
  assert.equal(calls, 1);
});

test('a download out of time rejects with the dropped connection', async (t) => {
  fastWaits(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 30_000));
  const sdk = client(() => { throw new TypeError('fetch failed'); });
  await assert.rejects(sdk.downloadAsset(asset), (error: any) => error instanceof TypeError && error.message === 'fetch failed');
});

test('a download that oversleeps its last pause still rejects with the dropped connection', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const real = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: () => void, ms = 0) => {
    if (ms >= 60_000) return real(fn, ms);
    now += 2000; // The pause runs late, past the deadline.
    return real(fn, 0);
  });
  let calls = 0;
  const sdk = client(() => { calls += 1; now += 118_500; throw new TypeError('fetch failed'); });
  await assert.rejects(sdk.downloadAsset(asset), (error: any) => error instanceof TypeError && error.message === 'fetch failed');
  assert.equal(calls, 1);
});
