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
