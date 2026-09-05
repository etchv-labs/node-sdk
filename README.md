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
await writeFile('watermarked.png', result.image);
const detection = await client.detectImage(result.image);
console.log(detection.watermarkId, detection.confidence);
```

`embedImage` returns a PNG `Uint8Array`, `watermarkId`, and `requestId`.
`detectImage` returns `watermarked`, `confidence`, `watermarkId` (or `null`),
and `requestId`. Write the returned PNG bytes directly without re-encoding them
to preserve the embedded identifier. Forensic data must be a non-empty JSON object; the service
embeds its SHA-256 digest. Detection recovers the digest, not the original data.
Inputs are encoded image bytes in a Buffer or Uint8Array (up to 20 MB).

Constructor options: `apiKey`, `baseUrl` (default `https://api.etchv.com`),
`timeout` in milliseconds (default 120000), and `fetch` for tests.
Both operations accept `{ filename, idempotencyKey }` as their final options.

Catch `EtchvError` for HTTP/protocol failures; inspect `statusCode`, `detail`,
and `requestId`. Fetch transport and timeout errors propagate separately.
401/403 indicate authentication/scopes, 402 unavailable credits or billing,
409 an idempotency conflict, and 422 invalid or unrecoverable images.
No automatic retries or redirects are performed. Reusing an idempotency key
may return 409; it does not replay the previous image. Save successful outputs.

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
