import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Etchv, parseWebhookEvent, verifyWebhookSignature, WebhookVerificationError, NotFoundError } from '../src/index.js';

const hook = 'wh_' + 'a'.repeat(32);
const event = 'evt_' + 'b'.repeat(64);
const secret = 'whsec_unit-test';

type Call = { url: URL; init: RequestInit & { headers: Record<string, string> } };
function client(handler: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  return new Etchv({ apiKey: 'test-key', fetch: (async (url: URL, init: Call['init']) => {
    const call = { url, init };
    calls.push(call);
    assert.equal(init.headers['X-API-Key'], 'test-key');
    assert.equal(init.redirect, 'manual');
    return handler(call);
  }) as unknown as typeof fetch });
}

test('webhook endpoints map to the documented routes and bodies', async () => {
  const calls: Call[] = [];
  const endpoint = { id: hook, url: 'https://example.com/hook', enabled: true, created_at: '2026-09-12T00:00:00Z' };
  const sdk = client(({ url, init }) => {
    const route = `${init.method} ${url.pathname}${url.search}`;
    switch (route) {
      case 'GET /webhooks': return Response.json([endpoint]);
      case 'POST /webhooks':
        assert.deepEqual(JSON.parse(String(init.body)), { url: endpoint.url });
        assert.equal(init.headers['Content-Type'], 'application/json');
        return Response.json({ ...endpoint, signing_secret: secret }, { status: 201 });
      case `PATCH /webhooks/${hook}`:
        assert.deepEqual(JSON.parse(String(init.body)), { enabled: false });
        return Response.json({ ...endpoint, enabled: false });
      case `DELETE /webhooks/${hook}`: return new Response(null, { status: 204 });
      case `GET /webhooks/${hook}/deliveries?after=${event}`: return Response.json({ data: [], next_cursor: null });
      case `POST /webhooks/${hook}/deliveries/${event}/redeliver`: return Response.json({ id: event, status: 'queued' }, { status: 202 });
      default: throw new Error('unexpected ' + route);
    }
  }, calls);
  assert.equal((await sdk.listWebhooks())[0].id, hook);
  assert.equal((await sdk.createWebhook({ url: endpoint.url })).signing_secret, secret);
  assert.equal((await sdk.updateWebhook(hook, { enabled: false })).enabled, false);
  assert.equal(await sdk.deleteWebhook(hook), undefined);
  assert.equal((await sdk.listWebhookDeliveries(hook, { after: event })).next_cursor, null);
  assert.deepEqual(await sdk.redeliverWebhookEvent(hook, event), { id: event, status: 'queued' });
  assert.equal(calls.length, 6);
  await assert.rejects(sdk.updateWebhook('../x', { enabled: true }), TypeError);
  await assert.rejects(sdk.createWebhook({ url: 'http://example.com' }), TypeError);
  await assert.rejects(sdk.redeliverWebhookEvent(hook, 'evt_bad'), TypeError);
  assert.equal(calls.length, 6);
});

test('webhook errors are typed', async () => {
  const sdk = client(() => Response.json({ detail: 'Webhook endpoint not found or disabled' }, { status: 404, headers: { 'x-request-id': 'req_hook' } }));
  await assert.rejects(sdk.deleteWebhook(hook), (e: any) => e instanceof NotFoundError && e.statusCode === 404 && e.requestId === 'req_hook' && /not found/.test(e.message));
});

function sign(body: string, timestamp: number, key = secret) {
  return 'v1=' + createHmac('sha256', key).update(`${timestamp}.${body}`).digest('hex');
}

test('webhook signatures follow the documented HMAC scheme', () => {
  const body = JSON.stringify({ id: event, type: 'watermark.embed.succeeded', api_version: '2026-09-12', created_at: 'now', data: { request_id: 'req_x' } });
  const now = 1_790_000_000_000;
  const timestamp = now / 1000;
  const headers = { 'x-etchv-event-id': event, 'x-etchv-timestamp': String(timestamp), 'x-etchv-signature': sign(body, timestamp) };
  assert.equal(verifyWebhookSignature(body, headers, secret, { now }), true);
  assert.equal(verifyWebhookSignature(Buffer.from(body), new Headers(headers), secret, { now }), true);
  assert.equal(parseWebhookEvent(body, headers, secret, { now }).type, 'watermark.embed.succeeded');
  // Tampering, the wrong secret, stale timestamps and missing headers all fail.
  assert.equal(verifyWebhookSignature(body + ' ', headers, secret, { now }), false);
  assert.equal(verifyWebhookSignature(body, headers, 'whsec_other', { now }), false);
  assert.equal(verifyWebhookSignature(body, headers, secret, { now: now + 301_000 }), false);
  assert.equal(verifyWebhookSignature(body, headers, secret, { now: now + 301_000, toleranceSeconds: 600 }), true);
  assert.equal(verifyWebhookSignature(body, { ...headers, 'x-etchv-signature': undefined }, secret, { now }), false);
  assert.equal(verifyWebhookSignature(body, { ...headers, 'x-etchv-timestamp': 'abc' }, secret, { now }), false);
  assert.throws(() => parseWebhookEvent(body, { ...headers, 'x-etchv-event-id': 'evt_other' }, secret, { now }), WebhookVerificationError);
  assert.throws(() => parseWebhookEvent(body + 'x', headers, secret, { now }), WebhookVerificationError);
  const notJson = 'not json';
  assert.throws(() => parseWebhookEvent(notJson, { ...headers, 'x-etchv-signature': sign(notJson, timestamp) }, secret, { now }), WebhookVerificationError);
  assert.throws(() => verifyWebhookSignature({} as any, headers, secret), TypeError);
});
