import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv } from '../src/index.js';

const id = 'ab'.repeat(32);
const uploadId = 'upl_' + '1'.repeat(32);
const png = new Uint8Array(300); png.set([137, 80, 78, 71, 13, 10, 26, 10]);
const session = (kind: string) => ({ upload_id: uploadId, kind, filename: 'photo.png', size: png.byteLength, status: 'pending',
  expires_at: '2026-10-10T00:00:00Z', upload: { method: 'PUT', url: `https://uploads.etchv.com/${kind}/${uploadId}.png?Signature=s`, expires_at: 'x' } });

test('large embeds upload once, without the API key, then send the upload_id', async () => {
  const calls = [];
  const sdk = new Etchv({ apiKey: 'test-key', largeFileThreshold: 100, fetch: async (url: string | URL | Request, init: RequestInit & { body?: any; headers?: any }) => {
    const target = new URL(String(url));
    calls.push(`${init.method} ${target.host}${target.pathname}`);
    if (target.pathname === '/uploads') {
      assert.deepEqual(JSON.parse(init.body), { kind: 'image', filename: 'photo.png', size: png.byteLength });
      return Response.json(session('image'), { status: 201 });
    }
    if (target.host === 'uploads.etchv.com') {
      assert.equal(init.headers['X-API-Key'], undefined);
      assert.deepEqual(init.body, png);
      return new Response(null, { status: 200 });
    }
    assert.equal(init.body.get('file'), null);
    assert.equal(init.body.get('upload_id'), uploadId);
    return new Response(png, { headers: { 'content-type': 'image/png', 'x-watermark-id': id } });
  } });
  const result = await sdk.embedImage(png, { recipient: 'test' }, { filename: 'photo.png' });
  assert.equal(result.watermarkId, id);
  assert.deepEqual(calls, ['POST api.etchv.com/uploads', `PUT uploads.etchv.com/image/${uploadId}.png`, 'POST api.etchv.com/watermarks/images']);
});

test('retries resend the same upload without uploading again', async () => {
  let puts = 0; const posts = [];
  const sdk = new Etchv({ apiKey: 'test-key', largeFileThreshold: 100, fetch: async (url: string | URL | Request, init: RequestInit & { body?: any; headers?: any }) => {
    const target = new URL(String(url));
    if (target.pathname === '/uploads') return Response.json(session('image'), { status: 201 });
    if (target.host === 'uploads.etchv.com') { puts += 1; return new Response(null, { status: 200 }); }
    posts.push(init.body.get('upload_id'));
    if (posts.length === 1) return Response.json({ detail: 'busy' }, { status: 503 });
    return new Response(png, { headers: { 'content-type': 'image/png', 'x-watermark-id': id } });
  } });
  await sdk.embedImage(png, { recipient: 'test' });
  assert.deepEqual([puts, posts], [1, [uploadId, uploadId]]);
});

test('large sync image detection runs as a job', async () => {
  const requestId = 'req_' + 'c'.repeat(64);
  const big = new Uint8Array(95 * 1024 * 1024 + 1); big.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const paths = [];
  const sdk = new Etchv({ apiKey: 'test-key', fetch: async (url: string | URL | Request, init: RequestInit & { body?: any; headers?: any }) => {
    const target = new URL(String(url)); paths.push(target.pathname);
    if (target.pathname === '/uploads') { assert.equal(JSON.parse(init.body).kind, 'detect'); return Response.json(session('detect'), { status: 201 }); }
    if (target.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    if (target.pathname === '/watermarks/images/detect/async') return Response.json({ request_id: requestId }, { status: 202 });
    return Response.json({ watermarked: true, confidence: 0.99, watermark_id: id });
  } });
  assert.equal((await sdk.detectImage(big)).watermarkId, id);
  assert.deepEqual(paths, ['/uploads', `/detect/${uploadId}.png`, '/watermarks/images/detect/async', `/watermarks/detection-jobs/${requestId}/result`]);
});

test('small files stay in the request body; limits follow the operation', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: async (url: string | URL | Request, init: RequestInit & { body?: any; headers?: any }) => {
    assert.ok(init.body.get('file'));
    return new Response(png, { headers: { 'content-type': 'image/png', 'x-watermark-id': id } });
  } });
  await sdk.embedImage(png, { recipient: 'test' });
  await assert.rejects(sdk.embedImage(new Uint8Array(50 * 1024 * 1024 + 1), { a: 1 }), /50 MB/);
  await assert.rejects(sdk.detectImage(new Uint8Array(192 * 1024 * 1024 + 1)), /192 MB/);
  await assert.rejects(sdk.uploadFile('audio' as any, png), /kind/);
});

test('a refused upload raises with its status', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: async (url: string | URL | Request) => new URL(String(url)).pathname === '/uploads'
    ? Response.json(session('image'), { status: 201 }) : new Response('Forbidden', { status: 403 }) });
  await assert.rejects(sdk.uploadFile('image', png), (error: any) => error.statusCode === 403);
});
