import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv } from '../src/index.js';

const id = 'ab'.repeat(32);
const pdf = new TextEncoder().encode('%PDF-1.7\nfixture');
const zip = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]);
const job = 'req_' + 'e'.repeat(64);
const batchId = 'bat_' + 'b'.repeat(32);
type Init = RequestInit & { body?: any };
const client = (handler: (url: URL, init: Init) => Response | Promise<Response>) => new Etchv({ apiKey: 'test-key',
  fetch: ((url: string | URL, init: Init) => handler(new URL(String(url)), init)) as unknown as typeof fetch });
const batch = (status: string, extra: Record<string, unknown> = {}) => ({
  batch_id: batchId, status, item_count: 1, archive: false, accelerator: 'cpu', webhook_id: null, storage_destination_id: null,
  counts: { pending: 0, accepted: 0, rejected: 0, succeeded: 0, failed: 0, in_progress: 0 },
  credits: { reserved: 0, charged: 0, refunded: 0 }, cancel_requested: false, created_at: '2026-10-26T00:00:00Z',
  started_at: null, completed_at: null, upload_expires_at: '2026-10-27T00:00:00Z', status_url: `/watermarks/batches/${batchId}`,
  items: [], ...extra,
});

test('activeContent is sent on document embedding only when set', async () => {
  const seen: URL[] = [];
  const sdk = client((url) => {
    seen.push(url);
    return url.pathname.endsWith('/async')
      ? Response.json({ request_id: job, status: 'queued' }, { status: 202 })
      : new Response(pdf, { headers: { 'content-type': 'application/pdf', 'x-watermark-id': id } });
  });
  await sdk.embedDocument(pdf, { a: 1 }, { activeContent: 'remove_auto_run', accelerator: 'gpu' });
  await sdk.submitEmbed('documents', pdf, { a: 1 }, { activeContent: 'keep' });
  await sdk.embedDocument(pdf, { a: 1 });
  assert.deepEqual(Object.fromEntries(seen[0].searchParams), { accelerator: 'gpu', active_content: 'remove_auto_run' });
  assert.deepEqual([seen[1].pathname, seen[1].search], ['/watermarks/documents/async', '?active_content=keep']);
  assert.equal(seen[2].search, '');
});

test('invalid values and other media are refused before any request', async () => {
  let calls = 0;
  const sdk = client(() => { calls++; return new Response(null, { status: 500 }); });
  for (const value of ['strip', 'KEEP', '', 1]) {
    await assert.rejects(sdk.embedDocument(pdf, { a: 1 }, { activeContent: value as any }),
      { name: 'TypeError', message: "activeContent must be 'keep' or 'remove_auto_run'" });
    await assert.rejects(sdk.submitBatchZip(zip, [{ filename: 'a.pdf', data: { a: 1 } }], { activeContent: value as any }), TypeError);
  }
  // The typings refuse these too; untyped callers get the run-time check.
  // @ts-expect-error activeContent is a document embedding option
  await assert.rejects(sdk.embedImage(pdf, { a: 1 }, { activeContent: 'keep' }), /PDF documents only/);
  // @ts-expect-error activeContent is a document embedding option
  await assert.rejects(sdk.submitEmbed('videos', pdf, { a: 1 }, { activeContent: 'keep' }), /PDF documents only/);
  // @ts-expect-error activeContent is a document embedding option
  await assert.rejects(sdk.detectDocument(pdf, { activeContent: 'keep' }), /PDF documents only/);
  assert.equal(calls, 0);
});

test('batches send active_content and report it', async () => {
  const bodies: any[] = [];
  const sdk = client(async (url, init) => {
    if (url.host === 'uploads.etchv.com') return new Response(null, { status: 200 });
    if (url.pathname === '/watermarks/batches') {
      bodies.push(JSON.parse(init.body));
      return Response.json(batch('draft', { items: [{ index: 0, filename: 'a.pdf', size: pdf.byteLength, upload_id: 'upl_' + '0'.repeat(32),
        request_id: null, status: 'pending', error_code: null, error_detail: null, credits: null,
        upload: { method: 'PUT', url: `https://uploads.etchv.com/document/upl_${'0'.repeat(32)}.pdf?Expires=1`, expires_at: 'x' } }] }), { status: 201 });
    }
    if (url.pathname === '/watermarks/batches/zip') bodies.push(JSON.parse(String((init.body as FormData).get('manifest'))));
    return Response.json(batch('starting', { active_content: 'remove_auto_run' }), { status: 202 });
  });
  const started = await sdk.submitBatch([{ filename: 'a.pdf', file: pdf, data: { a: 1 } }], { activeContent: 'remove_auto_run' });
  const zipped = await sdk.submitBatchZip(zip, [{ filename: 'a.pdf', data: { a: 1 } }], { activeContent: 'remove_auto_run' });
  assert.equal(bodies[0].active_content, 'remove_auto_run');
  assert.deepEqual(bodies[1], { items: [{ filename: 'a.pdf', data: { a: 1 } }], archive: false, active_content: 'remove_auto_run' });
  assert.deepEqual([started.active_content, zipped.active_content], ['remove_auto_run', 'remove_auto_run']);
});
