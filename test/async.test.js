import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv } from '../src/index.js';

test('all async media operations return receipts without polling and keep callback and idempotency', async () => {
  const calls = [];
  const webhookId = 'wh_' + 'a'.repeat(32);
  const client = new Etchv({apiKey:'test-key', fetch: async (url, init) => {
    calls.push(String(url));
    if (!new URL(url).pathname.includes('/detect/')) {
      assert.equal(new URL(url).searchParams.get('storage_destination_id'), 'dst_' + 'c'.repeat(32));
      assert.equal(new URL(url).searchParams.get('storage_key'), 'a b/#file.pdf');
    }
    assert.equal(init.method, 'POST');
    assert.equal(new URL(url).searchParams.get('webhook_id'), webhookId);
    assert.equal(init.headers['Idempotency-Key'], 'stable_test_key');
    assert.equal(init.body.get('file').size, 3);
    return Response.json({request_id:'req_' + 'b'.repeat(64), status:'queued'}, {status:202});
  }});
  for (const media of ['images','documents','videos']) {
    const opts = {webhookId, idempotencyKey:'stable_test_key'};
    assert.equal((await client.submitEmbed(media, new Uint8Array([1,2,3]), {asset:'test'}, {...opts, storageDestinationId:'dst_' + 'c'.repeat(32), storageKey:'a b/#file.pdf'})).status, 'queued');
    assert.equal((await client.submitDetection(media, new Uint8Array([1,2,3]), opts)).status, 'queued');
  }
  assert.equal(calls.length, 6);
  assert(calls.every(url => new URL(url).pathname.endsWith('/async')));
});
