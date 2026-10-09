# Etchv Node SDK

Official server-side Node.js client for [Etchv](https://etchv.com): embed and
detect invisible forensic watermarks in images, PDFs and videos.

## Install

```sh
npm install @etchv-labs/sdk
```

Requires Node.js 22.12 or later. Works with ES modules and CommonJS (`require`), ships
TypeScript declarations, and has no runtime dependencies.

## Quickstart

Create an API key in the [Etchv dashboard](https://etchv.com/dashboard/api-keys)
and set `ETCHV_API_KEY` on your server. Embedding needs the `watermarks:embed`
scope, detection `watermarks:detect`, and both use credits.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { Etchv } from '@etchv-labs/sdk';

const client = new Etchv({ apiKey: process.env.ETCHV_API_KEY });

const result = await client.embedImage(await readFile('photo.jpg'),
  { recipient: 'customer-123' }, { filename: 'photo.jpg' });
await writeFile(result.filename, result.image); // write bytes as-is

const detection = await client.detectImage(result.image);
console.log(detection.watermarked, detection.watermarkId, detection.confidence);
```

Use `embedDocument` / `detectDocument` for PDFs and `embedVideo` / `detectVideo`
for MP4/MOV. Image uploads are limited to 50 MB; PDF and video uploads to 20 MB.
Detection takes the files Etchv delivered: up to 192 MB for images, 64 MB for
PDFs and 100 MB for video. Detection recovers a SHA-256 digest of your data, not
the data itself. Every method accepts `signal` and `timeout`.

## Large files

Files over 40 MB are uploaded once to a signed URL and then referenced by ID,
so the request never carries the file. This is automatic in every embed,
detect and submit method; retries reuse the same upload. Image and PDF
detection above 95 MB runs as a background job and the call waits for it.
Change the threshold with `new Etchv({ ..., largeFileThreshold })`, or upload
explicitly:

```js
const upload = await client.uploadFile('detect', delivered, { filename: 'delivered.tiff' });
upload.upload_id; // send as the upload_id form field instead of file
```

## GPU processing

On Business and Enterprise plans, pass `accelerator: 'gpu'` to any embed,
detect or `submit*` method (other plans get `PermissionDeniedError`, HTTP 403).
GPU operations cost 3× credits. If no GPU is ready, the job runs on CPU at
normal credits instead. `result.accelerator` reports what actually ran
(`'gpu'`, `'cpu'` or `null` if the response did not say); job receipts include
`accelerator_requested` and `accelerator`.

```js
const fast = await client.embedVideo(videoBytes, { recipient: 'customer-123' }, { accelerator: 'gpu' });
console.log(fast.accelerator); // 'gpu', or 'cpu' after a fallback
```

## Async jobs

```js
const job = await client.submitEmbed('documents', pdfBytes, { recipient: 'customer-123' },
  { filename: 'report.pdf', idempotencyKey: 'report-001' });
const { status } = await client.getJob(job.request_id); // queued … succeeded | failed
const file = await client.getEmbedResult(job.request_id); // waits for the file
```

`submitDetection`, `getJob(id, { detect: true })` and `getDetectionResult` work
the same way. Reusing an `idempotencyKey` with the same input returns the saved
result (kept 24 hours) without another charge.

## Many files at once

A batch watermarks up to 100 images, PDFs and videos with one call.
`submitBatch` creates the batch, uploads every file to its own signed URL
(four at a time, never with your API key) and starts it. Each item has its own
forensic data; the filename's extension sets the media type.

```js
import { basename } from 'node:path';

const files = ['in/acme.pdf', 'in/globex.pdf'];
const batch = await client.submitBatch(
  files.map(file => ({ filename: basename(file), file, data: { recipient: basename(file, '.pdf') } })),
  { archive: true }, // also zip every result into one download
);
await client.waitForBatch(batch.batch_id, { timeout: 30 * 60_000 }); // honors Retry-After between polls

for await (const item of client.iterBatchResults(batch.batch_id)) {
  if (item.ok) await writeFile(`out/${item.result.filename}`, item.result.image);
  else console.log(item.filename, item.errorCode); // not charged, or refunded
}

await client.downloadBatchArchiveTo(batch.batch_id, 'out.zip'); // streams to disk
```

`file` is a Buffer/Uint8Array or a file path. A batch costs the same credits
per file as single requests. Files that never arrive or fail their checks are
rejected (`upload_not_received`, `invalid_input`, ...) without a charge, and
failed files are refunded, so one bad file never stops the rest. Results are
kept 24 hours; the archive (with `archive: true`) holds every successful result
plus `manifest.json` and is limited to 1 GB. `downloadBatchArchiveTo` streams it
to a path or writable stream; `downloadBatchArchive` returns a `Uint8Array`.

More than 100 items reject with a `RangeError` before any request; split larger
sets into several batches. Pass `webhookId` to get one
`watermark.batch.completed`, `watermark.batch.failed` or
`watermark.batch.cancelled` event when the batch ends, and `accelerator` or
`storageDestinationId` as for single files. Retries reuse the same
`idempotencyKey` (generated when omitted). If an upload or the start still
fails, `BatchSubmitError` carries `batchId` and `idempotencyKey`; calling
`submitBatch` again with that key and the same items uploads only the files that
have not arrived and starts the batch. A batch not started within 24 hours
expires, and resuming it rejects with `GoneError`.

Files already in one zip (up to 55 MB) can go in one request; list every
member:

```js
const zipped = await client.submitBatchZip('in.zip', [{ filename: 'in/a.png', data: { recipient: 'a' } }]);
```

Also: `getBatch`, `cancelBatch` (files still waiting are canceled and
refunded; queued and running files finish) and
`listBatches({ limit, before })`.

## Also included

- API key check: `getApiKeyInfo()` (no credits used).
- Assets: `listAssets`, `getAsset`, `updateAsset`, `downloadAsset`,
  `deleteAsset`, `deleteAssets`.
- Webhooks: `createWebhook`, `listWebhooks`, `updateWebhook`, `deleteWebhook`,
  `listWebhookDeliveries`, `redeliverWebhookEvent`; verify deliveries with
  `parseWebhookEvent(rawBody, headers, secret)` (throws
  `WebhookVerificationError`) or `verifyWebhookSignature` (returns a boolean).
- Customer storage (S3, GCS, Azure): `createStorageDestination`,
  `listStorageDestinations`, `updateStorageDestination`,
  `verifyStorageDestination`, `deleteStorageDestination`,
  `createStorageDelivery`, `listStorageDeliveries`, `getStorageDelivery`,
  `retryStorageDelivery`, `downloadStorageDelivery`.

## Errors

API failures reject with `EtchvError` or a subclass such as
`AuthenticationError`, `PermissionDeniedError`, `ConflictError`, `GoneError`,
`InvalidRequestError`, `RateLimitError` or `EtchvTimeoutError`. Each carries
`statusCode`, `detail` and `requestId` (quote it to support). Messages never
include your API key. Embedding, video detection, async submissions and job
results retry HTTP 429 and transient 5xx responses after `Retry-After` (up to 5 s
per wait) until the call deadline; other calls reject with `RateLimitError` so you
can back off. Errors also expose `code` (for example `rate_limited` or
`concurrency_limited`), `limit` and `retryAfter` in seconds when the API sends them.

```js
import { EtchvError } from '@etchv-labs/sdk';

try {
  await client.detectImage(bytes);
} catch (error) {
  if (error instanceof EtchvError) console.error(error.statusCode, error.requestId);
  else throw error;
}
```

## Links

- Full guide: https://etchv.com/docs/sdks/node
- API reference: https://etchv.com/docs
- Support: hello@etchv.com

License: MIT (covers this SDK, not the hosted Etchv service).

Questions or bug reports: open an issue here or email hello@etchv.com.
