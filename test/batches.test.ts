import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir, unlink } from 'node:fs/promises';
import { PassThrough, Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Etchv, ARCHIVE_MAX_BYTES, BatchSubmitError, ConflictError, EtchvError, EtchvTimeoutError, GoneError, ServiceUnavailableError, MAX_BATCH_ITEMS } from '../src/index.js';
import type { Batch, BatchItemResult } from '../src/index.js';

const batchId = 'bat_' + 'b'.repeat(32);
const id = 'ab'.repeat(32);
const png = new Uint8Array(60); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
const pdf = new TextEncoder().encode('%PDF-1.7\n' + 'y'.repeat(80));
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]);
const requestId = (n: number) => 'req_' + String(n).repeat(64);
const uploadUrl = (index: number) => `https://uploads.etchv.com/image/upl_${String(index).padStart(32, '0')}.png?Expires=1&Signature=s&Key-Pair-Id=K1`;

type Init = RequestInit & { body?: any; headers?: any; duplex?: string };
type Handler = (url: URL, init: Init) => Response | Promise<Response>;
const client = (handler: Handler, options: { timeout?: number } = {}) => new Etchv({ apiKey: 'test-key', ...options,
  fetch: ((url: string | URL, init: Init) => handler(new URL(String(url)), init)) as unknown as typeof fetch });
// A clock that advances one second per read.
const ticking = (t: TestContext) => { let now = Date.now(); t.mock.method(Date, 'now', () => (now += 1000)); };
const one = [{ filename: 'photo.png', file: png, data: { a: 1 } }];

const item = (index: number, filename: string, status = 'pending', extra: Record<string, unknown> = {}) => ({
  index, filename, size: 1, upload_id: `upl_${String(index).padStart(32, '0')}`, request_id: null, status,
  error_code: null, error_detail: null, credits: null, ...extra,
});
const batch = (status = 'draft', items: unknown[] = [], extra: Record<string, unknown> = {}) => ({
  batch_id: batchId, status, item_count: items.length, archive: false, accelerator: 'cpu', webhook_id: null, storage_destination_id: null,
  counts: { pending: 0, accepted: 0, rejected: 0, succeeded: 0, failed: 0, in_progress: 0 },
  credits: { reserved: 0, charged: 0, refunded: 0 }, cancel_requested: false, created_at: '2026-10-09T00:00:00Z',
  started_at: null, completed_at: null, upload_expires_at: '2026-10-10T00:00:00Z', status_url: `/watermarks/batches/${batchId}`,
  items, ...extra,
});
const draft = (...names: string[]) => batch('draft', names.map((name, index) =>
  item(index, name, 'pending', { upload: { method: 'PUT', url: uploadUrl(index), expires_at: 'x' } })));

// Run short waits (polls, retries) at once and record them; real request deadlines stay as they are.
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

test('submitBatch creates, uploads without the API key, then starts', async (t) => {
  fastWaits(t);
  const folder = await mkdtemp(join(tmpdir(), 'etchv-batch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'contract.pdf');
  await writeFile(path, pdf);
  const calls: string[] = [];
  const puts = new Map<string, Uint8Array>();
  const sdk = client(async (url, init) => {
    calls.push(`${init.method} ${url.host}${url.pathname}`);
    if (url.host === 'uploads.etchv.com') {
      assert.equal(init.headers['X-API-Key'], undefined);
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(init.duplex, 'half');
      puts.set(url.pathname, new Uint8Array(await new Response(init.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    assert.equal(init.headers['X-API-Key'], 'test-key');
    if (url.pathname === '/watermarks/batches') {
      assert.match(init.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/);
      assert.deepEqual(JSON.parse(init.body), {
        items: [{ filename: 'photo.png', size: png.byteLength, data: { recipient: 'a' } },
          { filename: 'contract.pdf', size: pdf.byteLength, data: { recipient: 'b' } }],
        archive: true, accelerator: 'gpu',
      });
      return Response.json(draft('photo.png', 'contract.pdf'), { status: 201 });
    }
    assert.equal(url.pathname, `/watermarks/batches/${batchId}/start`);
    return Response.json(batch('starting'), { status: 202, headers: { 'retry-after': '2' } });
  });
  const started: Batch = await sdk.submitBatch([
    { filename: 'photo.png', file: png, data: { recipient: 'a' } },
    { filename: 'contract.pdf', file: path, data: { recipient: 'b' } },
  ], { archive: true, accelerator: 'gpu' });
  assert.equal(started.status, 'starting');
  assert.deepEqual(puts.get('/image/upl_00000000000000000000000000000000.png'), png);
  assert.deepEqual(puts.get('/image/upl_00000000000000000000000000000001.png'), pdf);
  assert.equal(calls[0], 'POST api.etchv.com/watermarks/batches');
  assert.equal(calls.at(-1), `POST api.etchv.com/watermarks/batches/${batchId}/start`);
  assert.equal(calls.length, 4);
});

test('create retries reuse one idempotency key', async (t) => {
  fastWaits(t);
  const keys: string[] = [];
  const sdk = client((url, init) => {
    if (url.pathname === '/watermarks/batches') {
      keys.push(init.headers['Idempotency-Key']);
      if (keys.length === 1) return Response.json({ detail: 'busy' }, { status: 502 });
      if (keys.length === 2) throw new TypeError('fetch failed');
      return Response.json(draft('photo.png'), { status: 201 });
    }
    if (url.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    return Response.json(batch('starting'), { status: 202 });
  });
  await sdk.submitBatch([{ filename: 'photo.png', file: png, data: { a: 1 } }]);
  assert.equal(keys.length, 3);
  assert.equal(new Set(keys).size, 1);
  keys.length = 0;
  await sdk.submitBatch([{ filename: 'photo.png', file: png, data: { a: 1 } }], { idempotencyKey: 'batch-0001' });
  assert.deepEqual(keys, ['batch-0001', 'batch-0001', 'batch-0001']);
});

test('unavailable uploads reject at once', async () => {
  const paths: string[] = [];
  const sdk = client((url) => { paths.push(url.pathname); return Response.json({ detail: 'Batch uploads are unavailable' }, { status: 503 }); });
  await assert.rejects(sdk.submitBatch([{ filename: 'photo.png', file: png, data: { a: 1 } }]), ServiceUnavailableError);
  assert.deepEqual(paths, ['/watermarks/batches']);
});

test('a replayed batch that already started is returned without uploading', async () => {
  const paths: string[] = [];
  const sdk = client((url) => { paths.push(url.pathname); return Response.json(batch('processing', [item(0, 'photo.png', 'queued')])); });
  const replay = await sdk.submitBatch([{ filename: 'photo.png', file: png, data: { a: 1 } }], { idempotencyKey: 'batch-0001' });
  assert.equal(replay.status, 'processing');
  assert.deepEqual(paths, ['/watermarks/batches']);
});

test('a refused upload says how to resume and does not start', async () => {
  const paths: string[] = [];
  const sdk = client((url) => {
    paths.push(url.pathname);
    return url.pathname === '/watermarks/batches' ? Response.json(draft('photo.png'), { status: 201 }) : new Response('Forbidden', { status: 403 });
  });
  await assert.rejects(sdk.submitBatch([{ filename: 'photo.png', file: png, data: { a: 1 } }], { idempotencyKey: 'batch-0001' }),
    (error: any) => {
      assert.ok(error instanceof BatchSubmitError);
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'batch_upload_failed');
      assert.deepEqual([error.batchId, error.idempotencyKey, error.index, error.filename], [batchId, 'batch-0001', 0, 'photo.png']);
      assert.match(error.message, /idempotencyKey 'batch-0001'/);
      return true;
    });
  assert.ok(!paths.includes(`/watermarks/batches/${batchId}/start`));
});

test('network timeouts during uploads still say how to resume', async (t) => {
  fastWaits(t); ticking(t);
  const sdk = client((url) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
    throw new TypeError('fetch failed');
  }, { timeout: 5000 });
  await assert.rejects(sdk.submitBatch(one), (error: any) => {
    assert.ok(error instanceof BatchSubmitError);
    assert.equal(error.statusCode, 0);
    assert.equal(error.batchId, batchId);
    assert.match(error.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.ok(error.cause instanceof EtchvTimeoutError);
    return true;
  });
});

test('unreadable files still say how to resume', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'etchv-batch-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, 'gone.png');
  await writeFile(path, png);
  const sdk = client(async () => { await unlink(path); return Response.json(draft('gone.png'), { status: 201 }); });
  await assert.rejects(sdk.submitBatch([{ filename: 'gone.png', file: path, data: { a: 1 } }], { idempotencyKey: 'batch-0001' }),
    (error: any) => error instanceof BatchSubmitError && error.idempotencyKey === 'batch-0001' && (error.cause as any)?.code === 'ENOENT');
});

test('a failed start says how to resume', async () => {
  const sdk = client((url) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
    if (url.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    return Response.json({ detail: 'boom' }, { status: 500 });
  });
  await assert.rejects(sdk.submitBatch(one, { idempotencyKey: 'batch-0001' }), (error: any) =>
    error instanceof BatchSubmitError && error.code === 'batch_start_failed' && error.statusCode === 500 && error.idempotencyKey === 'batch-0001');
});

test('upload time scales with the file size', async (t) => {
  fastWaits(t); ticking(t);
  // 1.25 MB gets about ten seconds beyond the 5 s client timeout.
  const big = new Uint8Array(10 * 128 * 1024 + 60); big.set(png);
  let attempts = 0;
  const sdk = client((url) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
    if (url.host === 'uploads.etchv.com') {
      attempts += 1;
      if (attempts < 4) throw new TypeError('slow uplink'); // About 9 s of failures: past the client timeout.
      return new Response(null, { status: 200 });
    }
    return Response.json(batch('starting'), { status: 202 });
  }, { timeout: 5000 });
  assert.equal((await sdk.submitBatch([{ filename: 'photo.png', file: big, data: { a: 1 } }])).status, 'starting');
  assert.equal(attempts, 4);
});

test('resuming skips files that already arrived', async () => {
  const replay = batch('draft', [item(0, 'photo.png', 'pending', { upload_received: true }),
    item(1, 'other.png', 'pending', { upload: { method: 'PUT', url: uploadUrl(1), expires_at: 'x' } })]);
  const puts: string[] = [];
  const sdk = client((url) => {
    if (url.pathname === '/watermarks/batches') return Response.json(replay);
    if (url.host === 'uploads.etchv.com') { puts.push(url.pathname); return new Response(null, { status: 200 }); }
    return Response.json(batch('starting'), { status: 202 });
  });
  await sdk.submitBatch([...one, { filename: 'other.png', file: png, data: { a: 2 } }], { idempotencyKey: 'batch-0001' });
  assert.deepEqual(puts, ['/image/upl_00000000000000000000000000000001.png']);
});

test('resuming an expired batch rejects clearly', async () => {
  const sdk = client(() => Response.json(batch('expired', [item(0, 'photo.png')])));
  await assert.rejects(sdk.submitBatch(one, { idempotencyKey: 'batch-0001' }), (error: any) =>
    error instanceof GoneError && error.code === 'batch_expired' && /new idempotencyKey/.test(error.message));
});

test('the 100-item cap and inputs are checked before any request', async () => {
  const sdk = client(() => { throw new Error('no request expected'); });
  assert.equal(MAX_BATCH_ITEMS, 100);
  const many = Array.from({ length: 101 }, (_, i) => ({ filename: `${i}.png`, file: png, data: { i } }));
  await assert.rejects(sdk.submitBatch(many), { name: 'RangeError', message: /1 to 100 files; got 101\. Split larger sets/ });
  await assert.rejects(sdk.submitBatch([]), RangeError);
  await assert.rejects(sdk.submitBatchZip(zip, many.map(({ filename, data }) => ({ filename, data }))), RangeError);
  await assert.rejects(sdk.submitBatch([{ filename: 'a.png', file: png, data: {} }]), /a\.png: data must be a non-empty JSON object/);
  await assert.rejects(sdk.submitBatch([{ filename: 'a.png', file: png, data: { a: 1 } }], { archive: true, storageDestinationId: 'dst_' + '1'.repeat(32) }), /cannot be combined/);
  await assert.rejects(sdk.submitBatch([{ filename: 'a.png', file: png, data: { a: 1 } }], { idempotencyKey: 'short' }), /idempotencyKey/);
  await assert.rejects(sdk.getBatch('bat_nope'), /Invalid batch ID/);
});

test('waitForBatch honors Retry-After between polls', async (t) => {
  const waits = fastWaits(t);
  const states: [string, string | null][] = [['starting', '3'], ['processing', '7'], ['completed', null]];
  const sdk = client((url, init) => {
    assert.equal(`${init.method} ${url.pathname}`, `GET /watermarks/batches/${batchId}`);
    const [status, retryAfter] = states.shift()!;
    return Response.json(batch(status), { headers: retryAfter ? { 'retry-after': retryAfter } : {} });
  });
  assert.equal((await sdk.waitForBatch(batchId)).status, 'completed');
  assert.deepEqual(waits, [3000, 7000]);
});

test('Retry-After is floored at one second', async (t) => {
  const waits = fastWaits(t);
  const states = ['processing', 'completed'];
  await client(() => Response.json(batch(states.shift()), { headers: { 'retry-after': '0' } })).waitForBatch(batchId);
  const archive = [() => Response.json(batch('processing'), { status: 202, headers: { 'retry-after': '0' } }), () => new Response(zip)];
  await client(() => archive.shift()!()).downloadBatchArchive(batchId);
  assert.deepEqual(waits, [1000, 1000]);
});

test('waitForBatch uses the longer of pollInterval and Retry-After, and times out', async (t) => {
  const waits = fastWaits(t);
  const states = ['processing', 'processing', 'failed'];
  const sdk = client(() => Response.json(batch(states.shift()), { headers: { 'retry-after': '2' } }));
  assert.equal((await sdk.waitForBatch(batchId, { pollInterval: 5000 })).status, 'failed');
  assert.deepEqual(waits, [5000, 5000]);
  const stuck = client(() => Response.json(batch('processing'), { headers: { 'retry-after': '1' } }));
  let now = Date.now();
  t.mock.method(Date, 'now', () => (now += 400));
  await assert.rejects(stuck.waitForBatch(batchId, { timeout: 1000 }), (error: any) =>
    error instanceof EtchvTimeoutError && (error.detail as any).batchId === batchId);
});

test('iterBatchResults reports each item: the file or its error code', async (t) => {
  fastWaits(t);
  const finished = batch('completed', [
    item(0, 'photo.png', 'succeeded', { request_id: requestId(1), credits: 1, result_url: `/watermarks/jobs/${requestId(1)}/result` }),
    item(1, 'missing.png', 'rejected', { error_code: 'upload_not_received', error_detail: 'The file was never uploaded' }),
    item(2, 'broken.pdf', 'failed', { request_id: requestId(2), credits: 0, error_code: 'invalid_input', error_detail: 'Not a PDF' }),
  ]);
  const paths: string[] = [];
  const sdk = client((url) => {
    paths.push(url.pathname);
    if (url.pathname === `/watermarks/batches/${batchId}`) return Response.json(finished);
    return new Response(png, { headers: { 'content-type': 'image/png', 'x-watermark-id': id, 'x-request-id': requestId(1) } });
  });
  const results: BatchItemResult[] = [];
  for await (const result of sdk.iterBatchResults(batchId)) results.push(result);
  assert.deepEqual(results.map(r => r.ok), [true, false, false]);
  assert.deepEqual(results[0].result?.image, png);
  assert.equal(results[0].result?.watermarkId, id);
  assert.deepEqual(results.map(r => r.errorCode), [null, 'upload_not_received', 'invalid_input']);
  assert.equal(results[2].errorDetail, 'Not a PDF');
  assert.deepEqual(paths, [`/watermarks/batches/${batchId}`, `/watermarks/jobs/${requestId(1)}/result`]);

  const cancelled = client(() => Response.json(batch('cancelled', [item(0, 'photo.png')])));
  for await (const result of cancelled.iterBatchResults(batchId)) assert.equal(result.errorCode, 'cancelled');
});

test('downloadBatchArchive waits while the API answers 202', async (t) => {
  const waits = fastWaits(t);
  const responses = [
    () => Response.json(batch('processing'), { status: 202, headers: { 'retry-after': '4' } }),
    () => Response.json(batch('assembling'), { status: 202 }),
    () => new Response(zip, { headers: { 'content-type': 'application/zip' } }),
  ];
  const sdk = client((url) => { assert.equal(url.pathname, `/watermarks/batches/${batchId}/archive`); return responses.shift()!(); });
  assert.deepEqual(await sdk.downloadBatchArchive(batchId), zip);
  assert.deepEqual(waits, [4000, 2000]);
  for (const code of ['archive_not_requested', 'batch_not_started']) {
    const none = client(() => Response.json({ detail: { code, message: 'No archive' } }, { status: 409 }));
    await assert.rejects(none.downloadBatchArchive(batchId), (error: any) => error instanceof ConflictError && error.code === code);
  }
  const expired = client(() => Response.json({ detail: 'The batch expired' }, { status: 410 }));
  await assert.rejects(expired.downloadBatchArchiveTo(batchId, new PassThrough()), GoneError);
});

// A body that sends `count` chunks of the archive, `gap` ms apart.
const slowZip = (count: number, gap: number, signal?: AbortSignal | null) => new ReadableStream<Uint8Array>({
  async start(controller) {
    signal?.addEventListener('abort', () => controller.error(signal.reason));
    for (let i = 0; i < count; i++) {
      await new Promise(resolve => setTimeout(resolve, gap));
      if (signal?.aborted) return;
      controller.enqueue(i === 0 ? zip : new Uint8Array(4).fill(i));
    }
    controller.close();
  },
});

test('archive downloads use an idle timeout, not a total one', async () => {
  // Five chunks 40 ms apart take longer than the 100 ms client timeout, but never pause that long.
  const sdk = client((_url, init) => new Response(slowZip(5, 40, init.signal)), { timeout: 100 });
  const bytes = await sdk.downloadBatchArchive(batchId);
  assert.equal(bytes.byteLength, zip.byteLength + 16);
  const stalled = client((_url, init) => new Response(slowZip(2, 300, init.signal)), { timeout: 100 });
  await assert.rejects(stalled.downloadBatchArchive(batchId), (error: any) => error instanceof EtchvTimeoutError && /stalled/.test(error.message));
});

test('downloadBatchArchiveTo streams to a path or a writable stream', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'etchv-archive-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const big = new Uint8Array(3 * 1024 * 1024); big.set(zip);
  const sdk = client(() => new Response(big, { headers: { 'content-type': 'application/zip' } }));
  const target = join(folder, 'out.zip');
  assert.equal(await sdk.downloadBatchArchiveTo(batchId, target), big.byteLength);
  assert.deepEqual(new Uint8Array(await readFile(target)), big);
  const sink = new PassThrough();
  const received: Buffer[] = [];
  sink.on('data', (chunk: Buffer) => received.push(chunk));
  assert.equal(await sdk.downloadBatchArchiveTo(batchId, sink), big.byteLength);
  assert.deepEqual(new Uint8Array(Buffer.concat(received)), big);
  const broken = client(() => new Response('not a zip'));
  await assert.rejects(broken.downloadBatchArchiveTo(batchId, join(folder, 'bad.zip')), (error: any) =>
    error instanceof EtchvError && error.statusCode === 200);
  assert.deepEqual(await readdir(folder), ['out.zip']);
});

test('cancelBatch, listBatches and submitBatchZip', async () => {
  const sdk = client(async (url, init) => {
    if (url.pathname.endsWith('/cancel')) {
      assert.equal(init.method, 'POST');
      return Response.json(batch('cancelled', [], { cancel_requested: true }));
    }
    if (url.pathname === '/watermarks/batches/zip') {
      assert.equal(init.headers['Idempotency-Key'], 'zip-batch-1');
      const form = init.body as FormData;
      const archive = form.get('archive') as File;
      assert.equal(archive.name, 'batch.zip');
      assert.deepEqual(new Uint8Array(await archive.arrayBuffer()), zip);
      assert.deepEqual(JSON.parse(String(form.get('manifest'))), { items: [{ filename: 'in/a.png', data: { r: 'a' } }], archive: true });
      return Response.json(batch('starting', [item(0, 'in/a.png', 'queued')]), { status: 202 });
    }
    assert.equal(`${url.pathname}${url.search}`, `/watermarks/batches?limit=5&before=${batchId}`);
    const { items: _, ...summary } = batch('completed');
    return Response.json({ data: [summary], next_cursor: null });
  });
  const cancelled = await sdk.cancelBatch(batchId);
  assert.equal(cancelled.cancel_requested, true);
  const page = await sdk.listBatches({ limit: 5, before: batchId });
  assert.equal(page.data[0].status, 'completed');
  assert.equal(page.next_cursor, null);
  const started = await sdk.submitBatchZip(zip, [{ filename: 'in/a.png', data: { r: 'a' } }], { archive: true, idempotencyKey: 'zip-batch-1' });
  assert.equal(started.items?.[0].filename, 'in/a.png');
});

// Consume a streamed PUT body one chunk at a time, `gap` ms apart, like a slow uplink.
async function slowUpload(init: Init, gap: number) {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  let bytes = 0;
  while (true) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, gap);
      init.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
    });
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

test('signed uploads time out only when no bytes move', async () => {
  // Five 64 KiB chunks 40 ms apart take longer than the 100 ms client timeout but never stall that long.
  const file = new Uint8Array(5 * 64 * 1024); file.set(png);
  let received = 0;
  const sdk = client(async (url, init) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
    if (url.host === 'uploads.etchv.com') { received = await slowUpload(init, 40); return new Response(null, { status: 200 }); }
    return Response.json(batch('starting'), { status: 202 });
  }, { timeout: 100 });
  assert.equal((await sdk.submitBatch([{ filename: 'photo.png', file, data: { a: 1 } }])).status, 'starting');
  assert.equal(received, file.byteLength);

  const stalled = client(async (url, init) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
    await slowUpload(init, 300);
    return new Response(null, { status: 200 });
  }, { timeout: 100 });
  await assert.rejects(stalled.submitBatch(one), (error: any) =>
    error instanceof BatchSubmitError && error.cause instanceof EtchvTimeoutError && error.batchId === batchId);
});

test('an abort during uploads or the start keeps what is needed to resume', async () => {
  for (const phase of ['upload', 'start']) {
    const controller = new AbortController();
    const sdk = client((url) => {
      if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png'), { status: 201 });
      if (url.host === 'uploads.etchv.com' && phase === 'start') return new Response(null, { status: 200 });
      controller.abort();
      throw controller.signal.reason;
    });
    await assert.rejects(sdk.submitBatch(one, { idempotencyKey: 'batch-0001', signal: controller.signal }), (error: any) => {
      assert.ok(error instanceof BatchSubmitError, phase);
      assert.equal(error.name, 'AbortError');
      assert.equal(error.code, 'batch_aborted');
      assert.deepEqual([error.batchId, error.idempotencyKey], [batchId, 'batch-0001']);
      assert.equal(error.cause, controller.signal.reason);
      return true;
    });
  }
});

test('a signal aborted before the upload starts stops it', async () => {
  // uploadFile: the signal is aborted right after the upload session is created.
  const controller = new AbortController();
  let puts = 0;
  const single = client((url) => {
    if (url.pathname === '/uploads') {
      controller.abort();
      return Response.json({ upload_id: 'upl_' + '1'.repeat(32), kind: 'image', filename: 'photo.png', size: png.byteLength,
        status: 'pending', expires_at: 'x', upload: { method: 'PUT', url: uploadUrl(0), expires_at: 'x' } }, { status: 201 });
    }
    puts += 1;
    return new Response(null, { status: 200 });
  });
  await assert.rejects(single.uploadFile('image', png, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(puts, 0);

  // submitBatch: aborted once the batch exists, before any upload.
  const batchAbort = new AbortController();
  const paths: string[] = [];
  const sdk = client((url) => {
    paths.push(url.pathname);
    if (url.pathname === '/watermarks/batches') {
      batchAbort.abort();
      return Response.json(draft('photo.png', 'other.png'), { status: 201 });
    }
    return new Response(null, { status: 200 });
  });
  await assert.rejects(sdk.submitBatch([...one, { filename: 'other.png', file: png, data: { a: 2 } }],
    { idempotencyKey: 'batch-0001', signal: batchAbort.signal }), (error: any) => {
    assert.ok(error instanceof BatchSubmitError);
    assert.equal(error.name, 'AbortError');
    assert.equal(error.code, 'batch_aborted');
    assert.deepEqual([error.batchId, error.idempotencyKey], [batchId, 'batch-0001']);
    return true;
  });
  assert.deepEqual(paths, ['/watermarks/batches']);
});

test('an abort during the retry wait stops further uploads', async () => {
  const controller = new AbortController();
  let puts = 0;
  const sdk = client((url) => {
    if (url.pathname === '/watermarks/batches') return Response.json(draft('photo.png', 'other.png'), { status: 201 });
    puts += 1;
    setTimeout(() => controller.abort(), 20); // Abort while the client waits to retry.
    return new Response('busy', { status: 503 });
  });
  const started = Date.now();
  await assert.rejects(sdk.submitBatch([...one, { filename: 'other.png', file: png, data: { a: 2 } }],
    { idempotencyKey: 'batch-0001', signal: controller.signal, uploadConcurrency: 1 }), (error: any) =>
    error instanceof BatchSubmitError && error.code === 'batch_aborted' && error.batchId === batchId);
  assert.equal(puts, 1);
  assert.ok(Date.now() - started < 900, 'the 1 s retry wait ends at the abort');
});

test('archives above the size cap are refused without retrying or allocating', async () => {
  assert.equal(ARCHIVE_MAX_BYTES, 1024 * 1024 * 1024 + 64 * 1024 * 1024);
  let calls = 0;
  const sdk = client(() => {
    calls += 1;
    return new Response(zip, { headers: { 'content-type': 'application/zip', 'content-length': String(ARCHIVE_MAX_BYTES + 1) } });
  });
  await assert.rejects(sdk.downloadBatchArchive(batchId), (error: any) => error instanceof EtchvError && error.code === 'archive_too_large');
  assert.equal(calls, 1);
});

test('downloadBatchArchiveTo fails fast on a bad path and does not count drain waits as idle', async (t) => {
  let calls = 0;
  const unreachable = client(() => { calls += 1; return new Response(zip); });
  await assert.rejects(unreachable.downloadBatchArchiveTo(batchId, join(tmpdir(), 'etchv-missing-dir', 'x', 'out.zip')), { code: 'ENOENT' });
  assert.equal(calls, 0);

  // Each write takes 150 ms (longer than the 100 ms client timeout) before 'drain'.
  const written: number[] = [];
  const slowDisk = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _encoding, callback) { written.push(chunk.byteLength); setTimeout(callback, 150); },
  });
  t.after(() => slowDisk.destroy());
  const chunks = [zip, new Uint8Array(10), new Uint8Array(10)];
  const sdk = client(() => new Response(new ReadableStream({ pull(c) { const next = chunks.shift(); if (next) c.enqueue(next); else c.close(); } })), { timeout: 100 });
  assert.equal(await sdk.downloadBatchArchiveTo(batchId, slowDisk), zip.byteLength + 20);
  assert.deepEqual(written, [zip.byteLength, 10, 10]);
});
