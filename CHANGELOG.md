# Changelog

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
