import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, EtchvError } from '../src/index.js';
const png = new Uint8Array([137,80,78,71,13,10,26,10,1]);
const id = 'ab'.repeat(32);

test('embedding sends multipart and exposes binary result and IDs', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: async (url, init) => {
    assert.equal(String(url), 'https://api.etchv.com/watermarks/images');
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

test('durable embed retries lost response with same key then polls a trusted URL', async () => {
  const job = 'req_' + id;
  const calls = [];
  const sdk = new Etchv({apiKey:'test-key', fetch:async (url, init) => {
    calls.push({url:String(url), ...init});
    if (calls.length === 1) throw new TypeError('connection lost');
    if (calls.length === 2) return Response.json({request_id:job, result_url:'https://evil.example/result'}, {status:202, headers:{'retry-after':'.01'}});
    assert.equal(init.method, 'GET');
    assert.equal(String(url), `https://api.etchv.com/watermarks/jobs/${job}/result`);
    return new Response(png, {headers:{'content-type':'image/png','x-watermark-id':id,'x-request-id':job}});
  }});
  assert.equal((await sdk.embedImage(png, {asset:'a'})).requestId, job);
  assert.ok(calls[0].headers['Idempotency-Key']);
  assert.equal(calls[0].headers['Idempotency-Key'], calls[1].headers['Idempotency-Key']);
});
test('terminal failure stops and deadline preserves recovery identifiers', async () => {
  let calls = 0;
  const job = 'req_' + id;
  const failed = new Etchv({apiKey:'test-key', fetch:async () => {
    calls++;
    return Response.json({status:'failed'}, {status:503});
  }});
  await assert.rejects(failed.embedImage(png, {asset:'a'}), e => e.statusCode === 503);
  assert.equal(calls, 1);
  const pending = new Etchv({apiKey:'test-key',timeout:25,fetch:async () => Response.json({request_id:job},{status:202})});
  await assert.rejects(pending.embedImage(png,{asset:'a'},{idempotencyKey:'recovery-key'}), e => e.statusCode === 0 && e.requestId === job && e.detail.idempotencyKey === 'recovery-key');
  await assert.rejects(pending.getEmbedResult(job), e => e.statusCode === 0 && e.requestId === job);
});
test('interrupted PNG download is replayed safely', async () => {
  let calls = 0;
  const sdk = new Etchv({apiKey:'test-key',fetch:async () => {
    calls++;
    if (calls === 1) return new Response(new ReadableStream({start(c){c.error(new Error('lost body'));}}));
    return new Response(png,{headers:{'content-type':'image/png','x-watermark-id':id}});
  }});
  assert.deepEqual((await sdk.embedImage(png,{asset:'a'})).image,png);
  assert.equal(calls,2);
});
