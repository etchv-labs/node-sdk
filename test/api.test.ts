import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as sdkModule from '../src/index.js';
import { Etchv, EtchvError, EtchvTimeoutError, GoneError, AuthenticationError, PermissionDeniedError, RateLimitError, ServiceUnavailableError, VERSION } from '../src/index.js';

const id = 'ab'.repeat(32);
const job = 'req_' + 'd'.repeat(64);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const mock = (handler: (url: URL, init: any) => Response | Promise<Response>) => handler as unknown as typeof fetch;

test('version constant, user agent and package metadata agree', async () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, VERSION);
  let agent = '';
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((_url, init) => { agent = init.headers['User-Agent']; return Response.json({ organization_id: 'org', key_id: 'key_1', scopes: [] }); }) });
  await sdk.getApiKeyInfo();
  assert.ok(agent.startsWith(`etchv-node/${VERSION} node/v`), agent);
});

test('ESM, CommonJS and package self-reference expose the same API', async () => {
  const required = createRequire(import.meta.url)('@etchv-labs/sdk');
  const imported = await import('@etchv-labs/sdk');
  for (const name of ['Etchv', 'EtchvError', 'GoneError', 'verifyWebhookSignature', 'parseWebhookEvent', 'VERSION']) {
    assert.equal(required[name], (sdkModule as any)[name], name);
    assert.equal((imported as any)[name], (sdkModule as any)[name], name);
  }
  assert.equal(pkg.exports['.'].types, './src/index.d.ts');
});

test('API key connection check returns identity and scopes', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url, init) => {
    assert.equal(url.pathname, '/auth/api-key');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['X-API-Key'], 'test-key');
    return Response.json({ organization_id: 'org_1', key_id: 'key_' + 'a'.repeat(32), scopes: ['watermarks:embed'] }, { headers: { 'cache-control': 'no-store' } });
  }) });
  assert.deepEqual(await sdk.getApiKeyInfo(), { organization_id: 'org_1', key_id: 'key_' + 'a'.repeat(32), scopes: ['watermarks:embed'] });
});

test('HTTP statuses map to typed errors carrying status and request ID without leaking secrets', async () => {
  const cases: [number, Function][] = [[401, AuthenticationError], [403, PermissionDeniedError], [410, GoneError], [429, RateLimitError], [503, ServiceUnavailableError]];
  for (const [status, Type] of cases) {
    const sdk = new Etchv({ apiKey: 'etchv_live_key_value', fetch: mock(() => Response.json({ detail: 'nope etchv_live_key_value' }, { status, headers: { 'x-request-id': 'req_status' } })) });
    await assert.rejects(sdk.getApiKeyInfo(), (e: any) => {
      assert.ok(e instanceof Type && e instanceof EtchvError);
      assert.equal(e.statusCode, status);
      assert.equal(e.requestId, 'req_status');
      assert.equal(e.name, Type.name);
      assert.ok(!e.message.includes('live_key_value') && !String(e.stack).includes('live_key_value'));
      return true;
    });
  }
  const html = new Etchv({ apiKey: 'test-key', fetch: mock(() => new Response('<html>bad gateway</html>', { status: 502 })) });
  await assert.rejects(html.getApiKeyInfo(), (e: any) => e.message === 'Etchv request failed (HTTP 502)' && e.detail.includes('bad gateway'));
});

test('async receipts, job status and detection results use their scoped routes', async () => {
  const receipt = { request_id: job, status: 'queued', operation: 'detect' };
  let calls = 0;
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url, init) => {
    calls++;
    if (url.pathname === '/watermarks/images/detect/async') {
      assert.ok(init.headers['Idempotency-Key']);
      return Response.json(receipt, { status: 202, headers: { 'retry-after': '2' } });
    }
    if (url.pathname === `/watermarks/detection-jobs/${job}`) return Response.json({ ...receipt, status: 'running' });
    assert.equal(url.pathname, `/watermarks/detection-jobs/${job}/result`);
    if (calls === 3) return Response.json({ ...receipt, status: 'running' }, { status: 202, headers: { 'retry-after': '0.01' } });
    return Response.json({ watermarked: true, confidence: 0.97, watermark_id: id, units: [{ index: 0, watermarked: true, confidence: 0.97, watermark_id: id }] }, { headers: { 'x-request-id': job } });
  }) });
  assert.equal((await sdk.submitDetection('images', png)).status, 'queued');
  assert.equal((await sdk.getJob(job, { detect: true })).status, 'running');
  const result = await sdk.getDetectionResult(job);
  assert.equal(result.watermarkId, id);
  assert.equal(result.requestId, job);
  assert.equal(calls, 4);
  await assert.rejects(sdk.submitDetection('images', png, { storageDestinationId: 'dst_' + 'a'.repeat(32) } as any), TypeError);
  await assert.rejects(sdk.submitEmbed('images', png, { a: 1 }, { idempotencyKey: 'bad key!' }), TypeError);
  assert.equal(calls, 4);
});

test('expired or deleted job results reject with GoneError without polling', async () => {
  for (const status of ['expired', 'deleted']) {
    let calls = 0;
    const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => { calls++; return Response.json({ status, request_id: job, detail: 'gone' }, { status: 410, headers: { 'x-request-id': job } }); }) });
    await assert.rejects(sdk.getEmbedResult(job), (e: any) => e instanceof GoneError && (e.detail as any).status === status && e.requestId === job);
    await assert.rejects(sdk.getDetectionResult(job), GoneError);
    assert.equal(calls, 2);
  }
});

test('abort signals cancel requests and stop durable polling', async () => {
  const controller = new AbortController();
  let calls = 0;
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => {
    calls++;
    setTimeout(() => controller.abort(new Error('caller cancelled')), 10);
    return Response.json({ request_id: job, status: 'running' }, { status: 202, headers: { 'retry-after': '5' } });
  }) });
  const started = Date.now();
  await assert.rejects(sdk.getEmbedResult(job, { signal: controller.signal }), /caller cancelled/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1000, 'abort interrupts the Retry-After wait');
  await assert.rejects(sdk.getApiKeyInfo({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
  const hanging = new Etchv({ apiKey: 'test-key', fetch: mock((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  })) });
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(new Error('stop')), 5);
  await assert.rejects(hanging.listAssets({ signal: cancel.signal }), /stop/);
  await assert.rejects(hanging.detectImage(png, { timeout: 10 }), (e: any) => e instanceof EtchvTimeoutError && e.statusCode === 0);
  await assert.rejects(hanging.getJob(job, { timeout: 0 }), TypeError);
});

test('getAsset can omit metadata', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock((url) => {
    assert.equal(url.searchParams.get('include_metadata'), 'false');
    return Response.json({ id: 'ast_' + 'a'.repeat(64) });
  }) });
  await sdk.getAsset('ast_' + 'a'.repeat(64), { includeMetadata: false });
  await assert.rejects(sdk.listAssets({ limit: 101 }), TypeError);
});
