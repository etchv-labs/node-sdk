import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, RateLimitError } from '../src/index.js';

const id = 'ab'.repeat(32);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');
const job = 'req_' + 'e'.repeat(64);
const mock = (handler: (url: URL, init: any) => Response | Promise<Response>) => handler as unknown as typeof fetch;
const image = (headers: Record<string, string> = {}) =>
  new Response(png, { headers: { 'content-type': 'image/png', 'x-watermark-id': id, ...headers } });
const detection = (extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  Response.json({ watermarked: true, confidence: 0.9, watermark_id: id, ...extra }, { headers });

test('accelerator query parameter is sent only when set', async () => {
  const seen: URL[] = [];
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url) => {
    seen.push(new URL(url));
    return new URL(url).pathname.endsWith('/detect') ? detection() : image();
  }) });
  await sdk.embedImage(png, { recipient: 'a' });
  await sdk.embedImage(png, { recipient: 'a' }, { accelerator: 'gpu' });
  await sdk.embedImage(png, { recipient: 'a' }, { accelerator: 'cpu' });
  await sdk.detectImage(png, { accelerator: 'gpu' });
  await sdk.detectDocument(png, { accelerator: 'gpu' });
  assert.equal(seen[0].search, '');
  assert.equal(seen[1].searchParams.get('accelerator'), 'gpu');
  assert.equal(seen[2].searchParams.get('accelerator'), 'cpu');
  assert.deepEqual(seen.slice(3).map(url => [url.pathname, url.search]),
    [['/watermarks/images/detect', '?accelerator=gpu'], ['/watermarks/documents/detect', '?accelerator=gpu']]);
});

test('accelerator combines with storage and webhook query parameters on async submissions', async () => {
  const seen: URL[] = [];
  const webhookId = 'wh_' + 'a'.repeat(32);
  const destination = 'dst_' + 'c'.repeat(32);
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url) => {
    seen.push(new URL(url));
    return Response.json({ request_id: job, status: 'queued', accelerator_requested: 'gpu', accelerator: null }, { status: 202 });
  }) });
  const receipt = await sdk.submitEmbed('videos', png, { a: 1 }, { webhookId, storageDestinationId: destination, storageKey: 'k', accelerator: 'gpu' });
  assert.equal(receipt.accelerator_requested, 'gpu');
  await sdk.submitDetection('documents', png, { webhookId, accelerator: 'gpu' });
  assert.equal(seen[0].pathname, '/watermarks/videos/async');
  assert.deepEqual(Object.fromEntries(seen[0].searchParams),
    { webhook_id: webhookId, storage_destination_id: destination, storage_key: 'k', accelerator: 'gpu' });
  assert.equal(seen[1].pathname, '/watermarks/documents/detect/async');
  assert.deepEqual(Object.fromEntries(seen[1].searchParams), { webhook_id: webhookId, accelerator: 'gpu' });
});

test('invalid accelerator values are rejected before any request', async () => {
  let calls = 0;
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => { calls++; return image(); }) });
  for (const accelerator of ['GPU', 'tpu', '', 1, true]) {
    await assert.rejects(sdk.embedImage(png, { a: 1 }, { accelerator: accelerator as any }), TypeError);
    await assert.rejects(sdk.detectImage(png, { accelerator: accelerator as any }), TypeError);
    await assert.rejects(sdk.submitEmbed('images', png, { a: 1 }, { accelerator: accelerator as any }), TypeError);
  }
  assert.equal(calls, 0);
});

test('actual accelerator is surfaced from the response header, including after CPU fallback', async () => {
  const cases: Array<[Record<string, string>, 'cpu' | 'gpu' | null]> = [
    [{ 'x-etchv-accelerator': 'gpu' }, 'gpu'], [{ 'x-etchv-accelerator': 'cpu' }, 'cpu'],
    [{}, null], [{ 'x-etchv-accelerator': 'quantum' }, null],
  ];
  for (const [headers, expected] of cases) {
    const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url) =>
      new URL(url).pathname.endsWith('/detect') ? detection({}, headers) : image(headers)) });
    assert.equal((await sdk.embedImage(png, { a: 1 }, { accelerator: 'gpu' })).accelerator, expected);
    assert.equal((await sdk.detectImage(png, { accelerator: 'gpu' })).accelerator, expected);
  }
});

test('durable GPU jobs poll the trusted result path and report the accelerator from the download or job JSON', async () => {
  const embedCalls: URL[] = [];
  const embed = new Etchv({ apiKey: 'test-key', fetch: mock((url) => {
    embedCalls.push(new URL(url));
    if (embedCalls.length === 1) return Response.json({ request_id: job }, { status: 202, headers: { 'retry-after': '0.01' } });
    return new Response(pdf, { headers: { 'content-type': 'application/pdf', 'x-watermark-id': id, 'x-etchv-accelerator': 'cpu' } });
  }) });
  assert.equal((await embed.embedDocument(pdf, { a: 1 }, { accelerator: 'gpu' })).accelerator, 'cpu');
  assert.equal(embedCalls[0].pathname + embedCalls[0].search, '/watermarks/documents?accelerator=gpu');
  assert.equal(embedCalls[1].pathname + embedCalls[1].search, `/watermarks/jobs/${job}/result`);

  const detectCalls: URL[] = [];
  const detect = new Etchv({ apiKey: 'test-key', fetch: mock((url) => {
    detectCalls.push(new URL(url));
    if (detectCalls.length === 1) return Response.json({ request_id: job }, { status: 202, headers: { 'retry-after': '0.01' } });
    return detection({ accelerator_requested: 'gpu', accelerator: 'gpu' });
  }) });
  assert.equal((await detect.detectVideo(png, { accelerator: 'gpu' })).accelerator, 'gpu');
  assert.equal(detectCalls[0].pathname + detectCalls[0].search, '/watermarks/videos/detect?accelerator=gpu');
  assert.equal(detectCalls[1].pathname, `/watermarks/detection-jobs/${job}/result`);

  const header = new Etchv({ apiKey: 'test-key', fetch: mock(() => detection({ accelerator: 'gpu' }, { 'x-etchv-accelerator': 'cpu' })) });
  assert.equal((await header.getDetectionResult(job)).accelerator, 'cpu');
});

test('durable requests retry 429 after Retry-After and stay within the deadline', async () => {
  const times: number[] = [];
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => {
    times.push(Date.now());
    if (times.length === 1) {
      return Response.json({ detail: { code: 'rate_limited' } }, { status: 429, headers: { 'retry-after': '0.2', 'x-ratelimit-remaining': '0' } });
    }
    return image({ 'x-etchv-accelerator': 'gpu' });
  }) });
  const result = await sdk.embedImage(png, { a: 1 }, { accelerator: 'gpu', idempotencyKey: 'stable-key-1' });
  assert.equal(result.accelerator, 'gpu');
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 150, `waited ${times[1] - times[0]} ms`);

  let calls = 0;
  const limited = new Etchv({ apiKey: 'test-key', timeout: 300, fetch: mock(() => {
    calls++;
    return Response.json({ detail: { code: 'concurrency_limited' } }, { status: 429, headers: { 'retry-after': '3600' } });
  }) });
  const started = Date.now();
  await assert.rejects(limited.embedImage(png, { a: 1 }), (error: any) => error.statusCode === 0);
  assert.ok(Date.now() - started < 2000);
  assert.equal(calls, 1);

  let detections = 0;
  const sync = new Etchv({ apiKey: 'test-key', fetch: mock(() => {
    detections++;
    return Response.json({ detail: { message: 'Rate limit exceeded', code: 'rate_limited', limit: 60 } },
      { status: 429, headers: { 'retry-after': '12' } });
  }) });
  await assert.rejects(sync.detectImage(png), (error: any) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.code, 'rate_limited');
    assert.equal(error.limit, 60);
    assert.equal(error.retryAfter, 12);
    assert.deepEqual(error.detail, { detail: { message: 'Rate limit exceeded', code: 'rate_limited', limit: 60 } });
    assert.match(error.message, /HTTP 429\): Rate limit exceeded$/);
    return true;
  });
  assert.equal(detections, 1);
});

test('durable 429 waits are capped at 5 seconds', async () => {
  const waits: number[] = [];
  const original = globalThis.setTimeout;
  // Record short timers (pauses) and fire them immediately; leave deadline timers alone.
  globalThis.setTimeout = ((fn: () => void, ms = 0, ...args: unknown[]) => {
    if (ms <= 10_000) { waits.push(ms); ms = 1; }
    return original(fn, ms, ...args);
  }) as typeof setTimeout;
  try {
    let calls = 0;
    const sdk = new Etchv({ apiKey: 'test-key', timeout: 60_000, fetch: mock(() => ++calls === 1
      ? Response.json({ detail: { code: 'concurrency_limited' } }, { status: 429, headers: { 'retry-after': '3600' } })
      : image()) });
    await sdk.embedImage(png, { a: 1 });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [5000]);
  } finally {
    globalThis.setTimeout = original;
  }
});

test('errors without a structured detail have null code, limit and retryAfter', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => Response.json({ detail: 'Forbidden' }, { status: 403 })) });
  await assert.rejects(sdk.getApiKeyInfo(), (error: any) => {
    assert.equal(error.code, null);
    assert.equal(error.limit, null);
    assert.equal(error.retryAfter, null);
    assert.match(error.message, /Forbidden$/);
    return true;
  });
});

test('structured 429 without Retry-After uses detail.message and null retryAfter', async () => {
  const body = { detail: { message: 'Too many concurrent jobs', code: 'concurrency_limited', limit: 2 } };
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => Response.json(body, { status: 429 })) });
  await assert.rejects(sdk.getApiKeyInfo(), (error: any) => {
    assert.ok(error instanceof RateLimitError);
    assert.equal(error.code, 'concurrency_limited');
    assert.equal(error.limit, 2);
    assert.equal(error.retryAfter, null);
    assert.match(error.message, /HTTP 429\): Too many concurrent jobs$/);
    return true;
  });
});
