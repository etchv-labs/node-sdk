import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, EtchvError } from '../src/index.js';
const png = new Uint8Array([137,80,78,71,13,10,26,10,1]);
const id = 'ab'.repeat(32);

test('embedding sends multipart and exposes binary result and IDs', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: async (url, init) => {
    assert.equal(String(url), 'https://pilot.api.etchv.com/watermarks/images');
    assert.equal(init.headers['X-API-Key'], 'test-key');
    assert.equal(init.headers['Idempotency-Key'], 'unique-request');
    assert.equal(init.redirect, 'manual');
    assert.equal(init.body.get('file').name, 'photo.png');
    assert.deepEqual(new Uint8Array(await init.body.get('file').arrayBuffer()), png);
    assert.deepEqual(JSON.parse(init.body.get('data')), { recipient: 'test' });
    return new Response(png, { headers: { 'content-type':'image/png', 'x-watermark-id':id, 'x-request-id':'req_1' } });
  }});
  assert.deepEqual(await sdk.embedImage(png, { recipient:'test' }, { filename:'photo.png', idempotencyKey:'unique-request' }), { image:png, watermarkId:id, requestId:'req_1' });
});
test('detection maps true and false results', async () => {
  for (const marked of [true, false]) {
    const sdk = new Etchv({ apiKey:'test-key', fetch:async (url) => {
      assert.equal(url.pathname, '/watermarks/images/detect');
      return Response.json({ watermarked:marked, confidence:0.9, watermark_id:marked ? id : null });
    }});
    assert.equal((await sdk.detectImage(png)).watermarked, marked);
  }
});
test('errors preserve status and request ID without retrying', async () => {
  for (const status of [302,401,402,403,409,422,429,503]) {
    let calls = 0;
    const sdk = new Etchv({ apiKey:'test-key', fetch:async () => {
      calls++;
      return Response.json({detail:'failure'}, {status, headers:{'x-request-id':'req_failure'}});
    }});
    await assert.rejects(sdk.detectImage(png), e => e instanceof EtchvError && e.statusCode === status && e.requestId === 'req_failure');
    assert.equal(calls, 1);
  }
});
test('invalid inputs and responses fail explicitly', async () => {
  assert.throws(() => new Etchv({apiKey:''}));
  assert.throws(() => new Etchv({apiKey:'test-key', baseUrl:'http://example.com'}));
  const sdk = new Etchv({apiKey:'test-key', fetch:async () => Response.json({watermarked:true, confidence:0.9, watermark_id:'bad'})});
  await assert.rejects(sdk.embedImage(png, {}), TypeError);
  await assert.rejects(sdk.embedImage(png, {value:NaN}), TypeError);
  await assert.rejects(sdk.detectImage(new Uint8Array()), TypeError);
  await assert.rejects(sdk.detectImage(png), EtchvError);
});
