# Changelog

## 1.7.0

- `detectImage` and `detectDocument` retry a dropped connection with the same
  `Idempotency-Key`, now generated when omitted, until the call deadline. The
  API returns the first result without charging again. A retry the API reports
  as still running (409 `request_in_progress`) waits for `Retry-After` (up to 5
  seconds) and is sent again; 409 `replay_expired` and `request_failed` reject
  with `ConflictError`. When time runs out, `EtchvTimeoutError` carries the key.
- `detectImage` and `detectDocument` take `keepResult` (`DetectOptions`). The
  API keeps an instant detection's result 24 hours so a retry gets it back; with
  `keepResult: false` it keeps nothing, and a retry runs detection again on the
  resent file at no charge. A file sent through an upload session is uploaded
  again for that, bounded like any upload; the resend after it stays within
  the client timeout counted from the first send. A retry that finds the first
  copy still using the upload (409 `upload_in_use`) waits like
  `request_in_progress`.
- `EtchvError.idempotencyKey` is the key a keyed call (embedding, a job or a
  detection) was sent with, including a generated one, so it can be resent. A
  network error from a detection's upload carries it as `idempotencyKey` too.
- `downloadAsset` and `downloadStorageDelivery` retry a dropped connection
  within the call deadline.
- `downloadBatchArchive` and `downloadBatchArchiveTo` start the download again
  from the beginning when the connection drops or stalls mid-download, emptying
  the buffer or the `.part` file first. A writable stream still rejects, since
  it already passed the bytes on.

## 1.6.0

- `deleteLink` deletes a traceable link with every recipient's opens,
  downloads and copy; `removeLinkRecipient` deletes one recipient's
  records and copy and resolves to the link without them. `LinkRecipient` has `id` (`lrc_...`).
  Both need an owner or admin and, for an API key, the `assets:delete` scope as
  well as `links:write`.

## 1.5.0

- Traceable links: `createLink` shares a source asset so each recipient
  downloads their own watermarked copy, with `recipients` or `allowedDomains`,
  `expiresAt`, `prepare`, `downloadLimit` and `webhookId`. Retries reuse one
  `Idempotency-Key`. Also `estimateLink`, `listLinks`, `getLink`,
  `listLinkEvents` and `revokeLink`, with `Link`, `LinkCreate`, `LinkEstimate`,
  `LinkEvent` and related types.
- Detection results have `copy` (the traceable link copy a watermark is on:
  link, recipient, first open) and `asset` (another watermarked asset of
  yours), when your key may read them; both are `null` otherwise.
- `WebhookEventType` includes `link.opened` and `link.locked`, with
  `LinkEventData`.

## 1.4.0

- `embedDocument`, `submitEmbed('documents', ...)`, `submitBatch` and
  `submitBatchZip` take `activeContent` (`'keep'`, the default, or
  `'remove_auto_run'`) to remove what a PDF viewer runs by itself. The new
  `ActiveContent` type names the values, and `Batch.active_content` reports a
  batch's choice. Other media throw `TypeError`.
- The README states the PDF limits: 1 to 2,000 pages and 50 MB to embed, 95 MB
  for the watermarked copy (48 KB per page) and 95 MB to detect.

## 1.3.0

- `embedVideo` and `detectVideo` results can now be WebM, Matroska (`.mkv`),
  MPEG program stream (`.mpg`), MPEG transport stream (`.ts`) or AVI, besides
  MP4 and MOV. Each result's content type is checked against the file's bytes.
- `embedDocument` and `detectDocument` take DOCX and PPTX, besides PDF.
- Detection units have `part`: the DOCX/PPTX package part that carries the
  unit, or `null` for other files.

## 1.2.0

- Batches: watermark up to 100 files in one call. `submitBatch(items, options)`
  creates the batch, uploads every file to its signed URL (`uploadConcurrency`
  at a time, never with the API key) and starts it; `waitForBatch` polls until
  the batch is final, honoring `Retry-After`; `iterBatchResults` is an async
  iterable of each item's verified file or its `errorCode`;
  `downloadBatchArchive` waits for and downloads the zip of a batch created
  with `archive: true`, and `downloadBatchArchiveTo` streams it to a path or
  writable stream. Archive downloads time out only when no data arrives for the
  client timeout.
- `submitBatchZip` sends files already in one zip (up to 55 MB) with a
  manifest. Also `getBatch`, `cancelBatch` and `listBatches`.
- Types: `Batch`, `BatchEntry`, `BatchItem`, `BatchItemResult`, `BatchOptions`,
  `BatchPage`, `ZipBatchItem` and the `watermark.batch.*` webhook events.
  `MAX_BATCH_ITEMS` is exported.
- More than 100 items reject with a `RangeError` before any request. Batch
  creation retries reuse one `Idempotency-Key`. Any failed upload or start
  rejects with `BatchSubmitError` carrying `batchId` and `idempotencyKey` to
  resume with; resuming skips files that already arrived and rejects with
  `GoneError` for an expired batch.
- Signed uploads (batches and `uploadFile`) stream the file and time out only
  when no bytes move for the client timeout, so parallel large uploads on a slow
  uplink finish; retries continue for the client timeout plus the time the file
  needs at 128 KiB/s.
- An abort through `signal` after the batch exists rejects with a
  `BatchSubmitError` (`code` `batch_aborted`, `name` `'AbortError'`) carrying
  `batchId` and `idempotencyKey`.
- Batch archives above `ARCHIVE_MAX_BYTES` (1 GiB + 64 MiB) are refused with
  `code` `archive_too_large` and not retried.

## 1.1.0

- Files above 40 MB (`largeFileThreshold`) are uploaded once to a signed URL,
  without the API key, and referenced by `upload_id`; retries reuse the same
  upload. `uploadFile` is public.
- Detection accepts delivered files up to 192 MB; image and PDF detection above
  95 MB runs as a job that the call waits for.
