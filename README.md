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

Use `embedDocument` / `detectDocument` for PDF, DOCX and PPTX and `embedVideo` /
`detectVideo` for MP4, MOV, WebM, Matroska, MPEG and AVI
([supported codecs](https://etchv.com/docs/api/videos#supported-files)). Image
and PDF uploads are limited to 50 MB; DOCX, PPTX and video uploads to 20 MB. A
PDF has 1 to 2,000 pages, and its watermarked copy must fit in 95 MB with 48 KB
per page, so a 2,000-page PDF can be up to about 1 MB. Detection takes the files
Etchv delivered: up to 192 MB for images, 95 MB for PDFs and 100 MB for DOCX,
PPTX and video. Detection recovers a SHA-256 digest of your data, not the data
itself. Every method accepts `signal` and `timeout`.

## Large files

Files over 40 MB are uploaded once to a signed URL and then referenced by ID,
so the request never carries the file. This is automatic in every embed,
detect and submit method; retries reuse the same upload. Image and
document detection above 95 MB runs as a background job and the call waits for it.
Change the threshold with `new Etchv({ ..., largeFileThreshold })`, or upload
explicitly:

```js
const upload = await client.uploadFile('detect', delivered, { filename: 'delivered.tiff' });
upload.upload_id; // send as the upload_id form field instead of file
```

## PDF scripts and actions

A watermarked PDF keeps its scripts, actions, form fields and attachments
exactly as uploaded. Pass `activeContent: 'remove_auto_run'` to `embedDocument`,
`submitEmbed('documents', ...)`, `submitBatch` or `submitBatchZip` to also
remove what a PDF viewer runs by itself: the open action, document and page
actions, document-level JavaScript and XFA forms. Links, form fields and
attachments stay. `'remove_auto_run'` is for PDFs only: the API refuses it for a
DOCX or PPTX, and for a batch unless every file is a PDF. Keeping active content
is accepted for any document and any batch.
[Scripts and actions](https://etchv.com/docs/api/documents#scripts-and-actions).

```js
const result = await client.embedDocument(await readFile('contract.pdf'), { recipient: 'counsel-7' },
  { filename: 'contract.pdf', activeContent: 'remove_auto_run' });
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

A batch watermarks up to 100 images, PDF, DOCX and PPTX documents, and videos
with one call.
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
`watermark.batch.cancelled` event when the batch ends, and `accelerator`,
`storageDestinationId` or `activeContent` as for single files. Retries reuse the same
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

## Traceable links

Share one file so each recipient downloads their own watermarked copy. Use the
source asset of a file you've watermarked; send the returned `url` yourself.

```ts
const link = await client.createLink({
  assetId: result.sourceAssetId!,
  name: 'Board pack, October',
  recipients: ['alex@example.com', 'sam@example.com'],
  downloadLimit: 3,
});
console.log(link.url);
```

Give `allowedDomains: ['example.com']` instead of `recipients` to let anyone at
those domains open it. `estimateLink` takes the same input and reports the
credits the copies would take without creating anything. Also `getLink` (each
recipient, their opens and their copy), `listLinks`, `listLinkEvents` and
`revokeLink`.

`deleteLink(id)` deletes a link with every recipient's opens, downloads and
copy; `removeLinkRecipient(id, recipientId)` does the same for one recipient
(their `id` in `getLink`) and resolves to the link without them. Neither can be
undone, and detection no longer names a deleted recipient. Both need an owner or
admin and, for an API key, `assets:delete` as well as `links:write`.

When a detected file is one of your links' copies, the detection result's
`copy` names the link, the recipient and when they first opened it (needs
`links:read`); `asset` names any other watermarked asset of yours (needs
`assets:read`). See https://etchv.com/docs/api/links.

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
