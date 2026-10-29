import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, NotFoundError, PaymentRequiredError, PermissionDeniedError } from '../src/index.js';

const asset = 'ast_' + 'e'.repeat(64);
const link = 'lnk_' + 'a'.repeat(32);
const event = 'lev_' + 'b'.repeat(32);
const hook = 'wh_' + 'c'.repeat(32);
const recipient = 'lrc_' + 'd'.repeat(32);
const view = { id: link, url: 'https://etchv.com/l/Yp3kQ8vN2rT6wX1zA4bC7d', name: 'Board pack', status: 'active', recipients: [] };

type Call = { url: URL; init: RequestInit & { headers: Record<string, string> } };
function client(handler: (call: Call) => Response | Promise<Response>, calls: Call[] = []) {
  return new Etchv({ apiKey: 'test-key', fetch: (async (url: URL, init: Call['init']) => {
    const call = { url, init };
    calls.push(call);
    assert.equal(init.headers['X-API-Key'], 'test-key');
    return handler(call);
  }) as unknown as typeof fetch });
}

test('createLink sends the body and keeps one idempotency key across retries', async () => {
  const calls: Call[] = [];
  const sdk = client(() => calls.length === 1 ? Response.json({ detail: 'busy' }, { status: 503 }) : Response.json(view, { status: 201 }), calls);
  const created = await sdk.createLink({ assetId: asset, name: 'Board pack', recipients: ['alex@example.com'],
    expiresAt: new Date('2026-11-26T14:02:00Z'), prepare: 'on_open', downloadLimit: 3, webhookId: hook });
  assert.equal(created.url, view.url);
  assert.deepEqual(calls.map(({ url, init }) => `${init.method} ${url.pathname}`), ['POST /links', 'POST /links']);
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key']);
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { asset_id: asset, name: 'Board pack', recipients: ['alex@example.com'],
    expires_at: '2026-11-26T14:02:00.000Z', prepare: 'on_open', download_limit: 3, webhook_id: hook });
});

test('createLink for domains sends only what was set, with a given key', async () => {
  const calls: Call[] = [];
  await client(() => Response.json(view), calls).createLink({ assetId: asset, name: 'Board pack', allowedDomains: ['example.com'] },
    { idempotencyKey: 'board-pack-2026-10' });
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'board-pack-2026-10');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { asset_id: asset, name: 'Board pack', allowed_domains: ['example.com'] });
});

test('too few credits rejects with PaymentRequiredError and its code', async () => {
  const detail = { detail: { code: 'insufficient_credits', message: 'This link needs 8 credits for its copies; 2 are available',
    estimated_credits: 8, available_credits: 2 } };
  await assert.rejects(client(() => Response.json(detail, { status: 402 })).createLink({ assetId: asset, name: 'Board pack', recipients: ['a@b.co'] }),
    (error: unknown) => error instanceof PaymentRequiredError && (error as PaymentRequiredError).code === 'insufficient_credits');
});

test('a 200-character name counts characters, and a null audience counts as not given', async () => {
  const calls: Call[] = [];
  const sdk = client(() => Response.json(view, { status: 201 }), calls);
  await sdk.createLink({ assetId: asset, name: '📄'.repeat(200), allowedDomains: ['example.com'], recipients: null as never });
  assert.deepEqual(Object.keys(JSON.parse(String(calls[0].init.body))), ['asset_id', 'name', 'allowed_domains']);
  await assert.rejects(sdk.createLink({ assetId: asset, name: '📄'.repeat(201), recipients: ['a@b.co'] }), TypeError);
});

test('invalid input is refused before any request', async () => {
  const sdk = client(() => { throw new Error('no request expected'); });
  const base = { assetId: asset, name: 'Board pack' };
  for (const input of [base, { ...base, recipients: ['a@b.co'], allowedDomains: ['b.co'] }, { ...base, recipients: 'a@b.co' },
    { ...base, recipients: [] }, { ...base, recipients: ['a@b.co'], prepare: 'later' }, { ...base, recipients: ['a@b.co'], downloadLimit: 0 },
    { ...base, recipients: ['a@b.co'], expiresAt: new Date('nope') }, { ...base, recipients: ['a@b.co'], webhookId: 'wh_1' },
    { ...base, assetId: 'ast_1', recipients: ['a@b.co'] }, { ...base, name: '', recipients: ['a@b.co'] }]) {
    await assert.rejects(sdk.createLink(input as never), TypeError, JSON.stringify(input));
  }
  await assert.rejects(sdk.createLink({ ...base, recipients: ['a@b.co'] }, { idempotencyKey: 'short' }), TypeError);
  await assert.rejects(sdk.getLink('lnk_1'), TypeError);
  await assert.rejects(sdk.listLinks({ limit: 51 }), TypeError);
  await assert.rejects(sdk.listLinkEvents(link, { before: link }), TypeError);
});

test('estimate, list, read, events and revoke map to the documented routes', async () => {
  const calls: Call[] = [];
  const sdk = client(({ url, init }) => {
    const route = `${init.method} ${url.pathname}${url.search}`;
    switch (route) {
      case 'POST /links/estimate': return Response.json({ estimated_credits: 8, enough_credits: true });
      case `GET /links?limit=5&before=${link}`: return Response.json({ data: [view], next_cursor: link });
      case `GET /links/${link}`: return Response.json(view);
      case `GET /links/${link}/events?limit=50&before=${event}`: return Response.json({ data: [{ id: event, type: 'opened' }], next_cursor: null });
      case `POST /links/${link}/revoke`: return Response.json({ ...view, status: 'revoked' });
      default: throw new Error('unexpected ' + route);
    }
  }, calls);
  assert.equal((await sdk.estimateLink({ assetId: asset, name: 'Board pack', recipients: ['a@b.co'] })).enough_credits, true);
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { asset_id: asset, name: 'Board pack', recipients: ['a@b.co'] });
  assert.equal((await sdk.listLinks({ limit: 5, before: link })).next_cursor, link);
  assert.equal((await sdk.getLink(link)).status, 'active');
  assert.equal((await sdk.listLinkEvents(link, { before: event })).data[0].type, 'opened');
  assert.equal((await sdk.revokeLink(link)).status, 'revoked');
});

test('deleteLink and removeLinkRecipient map to the documented routes', async () => {
  const calls: Call[] = [];
  const sdk = client(({ url, init }) => {
    const route = `${init.method} ${url.pathname}`;
    switch (route) {
      case `DELETE /links/${link}`: return new Response(null, { status: 204 });
      case `DELETE /links/${link}/recipients/${recipient}`: return Response.json({ ...view, recipients: [] });
      default: throw new Error('unexpected ' + route);
    }
  }, calls);
  assert.equal(await sdk.deleteLink(link), undefined);
  assert.deepEqual((await sdk.removeLinkRecipient(link, recipient)).recipients, []);
  assert.equal(calls.length, 2);
});

test('deletes surface refusals and check IDs before any request', async () => {
  await assert.rejects(client(() => Response.json({ detail: 'Recipient not found' }, { status: 404 })).removeLinkRecipient(link, recipient), NotFoundError);
  await assert.rejects(client(() => Response.json({ detail: 'needs assets:delete' }, { status: 403 })).deleteLink(link), PermissionDeniedError);
  const sdk = client(() => { throw new Error('no request expected'); });
  await assert.rejects(sdk.deleteLink('lnk_1'), TypeError);
  await assert.rejects(sdk.removeLinkRecipient(link, 'lrc_1'), TypeError);
  await assert.rejects(sdk.removeLinkRecipient('lnk_1', recipient), TypeError);
  await assert.rejects(sdk.removeLinkRecipient(link, link), TypeError);
});

test('detection names the copy or asset when the response has them', async () => {
  const copy = { asset_id: asset, link: { id: link, name: 'Board pack' }, recipient: 'alex@example.com', opened_at: null };
  const base = { watermarked: true, confidence: 0.9, watermark_id: 'ab'.repeat(32) };
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)]);
  const withCopy = await client(() => Response.json({ ...base, copy })).detectImage(png);
  assert.deepEqual([withCopy.copy, withCopy.asset], [copy, null]);
  const plain = await client(() => Response.json(base)).detectImage(png);
  assert.deepEqual([plain.copy, plain.asset], [null, null]);
  const request = 'req_' + 'f'.repeat(64);
  const job = await client(({ url }) => {
    assert.equal(url.pathname, `/watermarks/detection-jobs/${request}/result`);
    return Response.json({ ...base, copy });
  }).getDetectionResult(request);
  assert.deepEqual(job.copy, copy);
});
