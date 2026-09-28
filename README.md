# Etchv Node SDK

Official server-side Node.js client for [Etchv](https://etchv.com): embed and
detect invisible forensic watermarks in images, PDFs and videos.

## Install

```sh
npm install @etchv-labs/sdk
```

Requires Node.js 24.x. Works with ES modules and CommonJS (`require`), ships
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
Detection recovers a SHA-256 digest of your data, not the data itself. Every
method accepts `signal` and `timeout`.

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
include your API key.

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
