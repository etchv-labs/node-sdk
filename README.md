# Etchv Node SDK

Official server-side Node.js client for Etchv forensic image watermarking.
Node.js 22+, ES modules, TypeScript declarations, no runtime dependencies. MIT licensed.

## Install

Install from this repository (not yet published on npm):

```sh
npm install github:etchv-labs/node-sdk
```

## Embed and detect

Create an API key in [your Etchv account](https://etchv.com).
Set `ETCHV_API_KEY` in your environment. The key needs `watermarks:embed` and
`watermarks:detect` scopes and an active plan with available credits.

```js
import { readFile, writeFile } from 'node:fs/promises';
import { Etchv } from '@etchv/sdk';

const client = new Etchv({ apiKey: process.env.ETCHV_API_KEY });
const result = await client.embedImage(
  await readFile('photo.jpg'),
  { recipient: 'customer-123' },
  { filename: 'photo.jpg' },
);
await writeFile(result.filename, result.image);
const detection = await client.detectImage(result.image);
console.log(detection.watermarkId, detection.confidence);
```

`embedImage` returns native image bytes as a `Uint8Array`, `watermarkId`, `requestId`, `contentType`, and `filename`.
`detectImage` returns `watermarked`, `confidence`, `watermarkId` (or `null`),
and `requestId`. Write the returned image bytes directly without re-encoding them
to preserve the embedded identifier. Forensic data must be a non-empty JSON object; the service
embeds its SHA-256 digest. Detection recovers the digest, not the original data.
Inputs are encoded image bytes in a Buffer or Uint8Array (up to 20 MB).

Constructor options: `apiKey`, `baseUrl` (default `https://api.etchv.com`),
`timeout` in milliseconds (default 120000), and `fetch` for tests.
Both operations accept `{ filename, idempotencyKey }` as their final options.

Catch `EtchvError` for HTTP/protocol failures; inspect `statusCode`, `detail`,
and `requestId`. Embedding deadlines raise statusCode 0 with recovery identifiers; detection transport errors propagate separately.
401/403 indicate authentication/scopes, 402 unavailable credits or billing,
409 an idempotency conflict, and 422 invalid or unrecoverable images.
Embedding automatically retries transient transport/service failures with the same
idempotency key and polls pending jobs, returning the native image through one method call.
The client wait defaults to 120 seconds; a timeout does not cancel the durable job.
Reuse the same key and input to retrieve the saved result without another charge.
A changed input with the same key returns 409. Saved results are available for 24 hours.
Detection does not automatically retry. Neither operation follows redirects.

Keep API keys on your server; this SDK is not for browser applications.
Confidence is mean decoded-bit certainty, not a guarantee of exact recovery
after cropping, compression, or editing.

## Development and contributions

```sh
npm test
npm pack --dry-run
```

This public repository is synchronized from Etchv's development monorepo.
Issues and pull requests are welcome here; maintainers incorporate accepted
changes into the source before publishing the next snapshot. The MIT license
covers this SDK only, not the hosted Etchv service.

To resume a known embedding job, call `getEmbedResult(requestId)`. Supply your own stable
idempotency key when embedding if you need recovery across process restarts.


Version 0.4.0 supports native image, PDF and video results. Use the returned filename
when saving bytes; older clients that require PNG must be upgraded. Detection's
`units` field reports each frame, page or layered composite separately. The
top-level identifier is only present when all units recover the same watermark.

## PDF documents

Use `embedDocument` and `detectDocument` for native PDFs. The existing `image` result field contains PDF bytes. Selectable text and vector content are retained; detection reports one unit per page. See [PDF limits and preservation](https://etchv.com/docs/api/documents).

## Video

Use `embedVideo` / `detectVideo` for the supported H.264 MP4/MOV profile. Both methods poll durable jobs. Each successful operation costs one credit per started minute; audio is preserved but not watermarked. The `image` result field contains native video bytes. See [video requirements](https://etchv.com/docs/api/videos).

## Asset library

New successful embeddings save original and verified output assets. Files remain
downloadable for 30 days; records stay until deleted. Use `assets:read` for listing,
inspection and downloads, `assets:write` for edits, and `assets:delete` with current
owner/admin membership for deletion. Existing keys need replacement to add scopes.

```javascript
const page = await client.listAssets({ kind: 'watermarked', limit: 25 });
for (const item of page.items) {
  const asset = await client.getAsset(item.id);
  const updated = await client.updateAsset(asset.id, {
    version: asset.version, metadata: { campaign: 'spring' },
  });
  if (updated.file_available) {
    const bytes = await client.downloadAsset(updated.id);
  }
}
// Pass cursor: page.next_cursor with the same filters for the next page.
```

Edits require the current version; reload and reconcile on HTTP 409. Metadata is
replaced, not merged, and does not change the embedded watermark. Asset operations
consume no credits. Downloads require authentication and return the original file
format. Single and bulk deletion methods are also available; batches contain at
most 50 IDs and delete atomically. Deleting an output blocks its job result replay.
See [the asset API](https://etchv.com/docs/api/assets) for the complete contract.
