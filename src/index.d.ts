/// <reference types="node" />
/** SDK version. Sent in the `User-Agent` header of every request. */
export declare const VERSION: string;
/** Default `largeFileThreshold`: 40 MB. */
export declare const LARGE_FILE_THRESHOLD: number;
/** Most files in one batch: 100. */
export declare const MAX_BATCH_ITEMS: number;
/** Average upload speed retries allow for (128 KiB/s): uploads retry for the client timeout plus size / this rate. A single upload only times out when no bytes move for the client timeout. */
export declare const UPLOAD_MIN_BYTES_PER_SECOND: number;
/** Largest batch archive the SDK downloads: 1 GiB + 64 MiB. Larger ones reject with `code` `archive_too_large`. */
export declare const ARCHIVE_MAX_BYTES: number;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Media = 'images' | 'documents' | 'videos';
export type MediaType = 'image' | 'document' | 'video';
/** Processor for watermark embedding and detection. */
export type Accelerator = 'cpu' | 'gpu';

/** Options accepted by every API method. */
export interface CallOptions {
  /** Cancel the call. An aborted call rejects with the signal's reason and stops polling; a durable job may still complete. */
  signal?: AbortSignal;
  /** Override the client deadline for this call, in milliseconds. */
  timeout?: number;
}
/** Upload options for embedding and detection. */
export interface RequestOptions extends CallOptions {
  /** Upload filename; its stem names the watermarked result. */
  filename?: string;
  /** 8–128 letters, digits, hyphens or underscores. Generated automatically for durable operations. Persist it to recover after a restart. */
  idempotencyKey?: string;
  /** Deliver the watermarked result to a verified customer storage destination (`dst_…`). Embedding only. */
  storageDestinationId?: string;
  /** Relative object key beneath the destination prefix. Requires `storageDestinationId`. */
  storageKey?: string;
  /**
   * `'gpu'` requests GPU processing (Business and Enterprise plans; other plans
   * get 403). GPU operations cost 3× credits; when no GPU is ready the job runs
   * on CPU at normal credits. Omit for CPU (the default).
   */
  accelerator?: Accelerator;
}
export interface AsyncOptions extends RequestOptions {
  /** Enabled webhook endpoint (`wh_…`) that receives a signed terminal event. */
  webhookId?: string;
}

/** Result of `GET /auth/api-key`. */
export interface ApiKeyInfo { organization_id: string; key_id: string; scopes: string[] }

export type JobStatus = 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed';
/** Durable job receipt returned by async submission and job status methods. */
export interface Job {
  request_id: string; status: JobStatus; operation: 'embed' | 'detect';
  status_url: string; result_url: string; webhook_id: string | null; error_code: string | null;
  asset_id: string | null; source_asset_id: string | null; format: string; frame_count: number;
  attempts: number; credits: number; result_expires_at: string | null;
  storage_provider?: string; storage_delivery_id?: string | null; storage_destination_id?: string | null;
  /** Requested and actual processor (the actual one is `'cpu'` after an automatic fallback). */
  accelerator_requested?: Accelerator; accelerator?: Accelerator | null;
}
export interface EmbedResult {
  /** Native watermarked file bytes (image, PDF or video). Write them without re-encoding. */
  image: Uint8Array; watermarkId: string; requestId: string | null; contentType: string; filename: string;
  assetId: string | null; sourceAssetId: string | null; storageDeliveryId: string | null;
  /** Processor that actually ran, or `null` when the response did not say. */
  accelerator: Accelerator | null;
}
export interface DetectionUnit { index: number; watermarked: boolean; confidence: number; watermarkId: string | null }
export interface DetectionResult {
  units: DetectionUnit[]; watermarked: boolean; confidence: number; watermarkId: string | null; requestId: string | null;
  /** Processor that actually ran, or `null` when the response did not say. */
  accelerator: Accelerator | null;
}

/** HTTP or protocol failure. `statusCode` is 0 for a client deadline. */
export declare class EtchvError extends Error {
  constructor(statusCode: number, detail: unknown, requestId?: string | null, retryAfter?: number | null);
  /** HTTP status, or 0 when the client deadline passed. */
  statusCode: number;
  /** Parsed error body (usually `{ detail: ... }`, where `detail` may be a string or an object). */
  detail: unknown;
  /** `X-Request-ID` or job request ID, for support and recovery. */
  requestId: string | null;
  /** Machine-readable `detail.code` from the API, such as `'rate_limited'` or `'concurrency_limited'` on HTTP 429. */
  code: string | null;
  /** Numeric `detail.limit` from the API (the exceeded rate or concurrency limit), when present. */
  limit: number | null;
  /** `Retry-After` delay in seconds, when the API sent one (HTTP 429). */
  retryAfter: number | null;
}
/** HTTP 401. */ export declare class AuthenticationError extends EtchvError {}
/** HTTP 402. */ export declare class PaymentRequiredError extends EtchvError {}
/** HTTP 403. */ export declare class PermissionDeniedError extends EtchvError {}
/** HTTP 404. */ export declare class NotFoundError extends EtchvError {}
/** HTTP 409. */ export declare class ConflictError extends EtchvError {}
/** HTTP 410: saved result or file expired or was deleted. */ export declare class GoneError extends EtchvError {}
/** HTTP 413 or 422. */ export declare class InvalidRequestError extends EtchvError {}
/** HTTP 429. */ export declare class RateLimitError extends EtchvError {}
/** HTTP 5xx. */ export declare class ServiceUnavailableError extends EtchvError {}
/** Client deadline exceeded (`statusCode` 0). `detail.idempotencyKey` is set for durable operations. */
export declare class EtchvTimeoutError extends EtchvError {}
/**
 * `submitBatch` failed after the batch was created. Call `submitBatch` again with
 * `idempotencyKey` and the same items to upload what is missing and start. `statusCode` is 0
 * for a network error, timeout, unreadable file or abort (see `cause`). After an abort through
 * `signal`, `code` is `batch_aborted` and `name` is the abort reason's name (usually `'AbortError'`).
 */
export declare class BatchSubmitError extends EtchvError {
  batchId: string;
  idempotencyKey: string;
  /** The file that failed, when one did. */
  index: number | null;
  filename: string | null;
}

export interface Asset {
  id: string; name: string; kind: 'source' | 'watermarked'; media_type: MediaType;
  format: string; content_type: string; size_bytes: number; sha256: string; parent_asset_id: string | null;
  request_id: string; watermark_id: string | null; created_at: string; updated_at: string;
  file_expires_at: string | null; file_available: boolean; version: number; metadata?: Record<string, JsonValue> | null; download_url: string | null;
  storage_provider?: 'etchv' | 's3' | 'gcs' | 'azure'; storage_status?: string; storage_destination_id?: string | null;
  storage_delivery_id?: string | null; staging_expires_at?: string | null; staging_deleted_at?: string | null;
}
export interface AssetPage { items: Asset[]; next_cursor: string | null }
export interface ListAssetsOptions extends CallOptions {
  /** 1–100 (default 25). */
  limit?: number; cursor?: string; kind?: 'source' | 'watermarked'; mediaType?: MediaType; watermarkId?: string;
}
export interface AssetUpdate { version: number; name?: string; metadata?: Record<string, JsonValue> | null }

export interface WebhookEndpoint { id: string; url: string; enabled: boolean; created_at: string }
/** Returned once on creation. Store `signing_secret` securely; it cannot be retrieved again. */
export interface CreatedWebhookEndpoint extends WebhookEndpoint { signing_secret: string }
export interface WebhookAttempt { at: string; status_code: number | null; error: string | null }
export interface WebhookDelivery {
  id: string; request_id: string; status: 'queued' | 'delivering' | 'retrying' | 'delivered' | 'exhausted' | 'cancelled';
  attempts: number; created_at: string; next_attempt_at: string; history: WebhookAttempt[]; payload: WebhookEvent;
}
export interface WebhookDeliveryPage { data: WebhookDelivery[]; next_cursor: string | null }
export type WebhookEventType =
  | 'watermark.embed.succeeded' | 'watermark.embed.failed' | 'watermark.detect.succeeded' | 'watermark.detect.failed'
  | 'storage.delivery.succeeded' | 'storage.delivery.failed'
  | 'watermark.batch.completed' | 'watermark.batch.failed' | 'watermark.batch.cancelled';
/** `data` of a `watermark.batch.*` event, sent once when the batch ends. */
export interface BatchEventData {
  batch_id: string; status: 'completed' | 'failed' | 'cancelled'; item_count: number;
  counts: Record<string, number>; credits: Record<string, number>; status_url: string;
  archive_status?: string | null; archive_url?: string; archive_expires_at?: string | null;
}
export interface StorageDeliveryEventData {
  delivery_id: string; asset_id: string; request_id: string; destination_id: string;
  status: string; error_code: string | null; uri: string | null; public_url: string | null;
}
/** Verified webhook event. Watermark events carry a job receipt plus `watermark_id`. */
export interface WebhookEvent {
  id: string; type: WebhookEventType | (string & {}); api_version: string; created_at: string;
  data: (Job & { watermark_id: string | null }) | StorageDeliveryEventData | BatchEventData | Record<string, JsonValue>;
}
export interface WebhookVerifyOptions {
  /** Maximum clock difference in seconds (default 300). */
  toleranceSeconds?: number;
  /** Current time in milliseconds (default `Date.now()`). */
  now?: number;
}
export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;
export type WebhookPayload = string | Uint8Array | ArrayBuffer;

export type StorageProvider = 's3' | 'gcs' | 'azure';
export interface StorageDestination {
  id: string; name: string; provider: StorageProvider; bucket: string; prefix: string; visibility: 'private' | 'public';
  region: string | null; role_arn: string | null; account: string | null; external_id: string; enabled: boolean;
  verified_at: string | null; created_at: string; last_error: string | null; credential_expires_at: string | null;
  gcs_auth: 'service_account_key' | 'workload_identity' | null; gcs_workload_identity_provider: string | null;
  gcs_service_account: string | null; aws_principal_arn: string | null; gcs_subject: string | null;
}
/** Body for `POST /storage/destinations`. See https://etchv.com/docs/storage for per-provider fields. */
export interface StorageDestinationCreate {
  name: string; provider: StorageProvider; bucket: string; prefix?: string; visibility?: 'private' | 'public';
  /** S3 only. */ region?: string;
  /** S3 only: `arn:aws:iam::<account>:role/etchv-storage-…`. */ role_arn?: string;
  /** Azure only: storage account name. */ account?: string;
  /** GCS service account JSON key or Azure container SAS. Never returned. */ credentials?: string;
  gcs_auth?: 'service_account_key' | 'workload_identity'; gcs_workload_identity_provider?: string; gcs_service_account?: string;
}
export interface StorageDestinationUpdate { enabled?: boolean; credentials?: string }
export type StorageDeliveryStatus = 'queued' | 'uploading' | 'retrying' | 'stored' | 'failed' | 'cancelled';
export interface StorageDelivery {
  id: string; asset_id: string; request_id: string; destination_id: string; provider: StorageProvider; key: string;
  uri: string | null; public_url: string | null; status: StorageDeliveryStatus; attempts: number; created_at: string;
  next_attempt_at: string | null; completed_at: string | null; error_code: string | null;
  history: Record<string, JsonValue>[]; expires_at: string | null;
}
export interface StorageDeliveryPage { items: StorageDelivery[]; next_cursor: string | null }

/** Batch lifecycle. `completed`, `failed`, `cancelled` and `expired` are final. */
export type BatchStatus = 'draft' | 'starting' | 'processing' | 'assembling' | 'completed' | 'failed' | 'cancelled' | 'expired';
/** One file's state inside a batch. */
export type BatchItemStatus = 'pending' | 'rejected' | 'queued' | 'running' | 'retrying' | 'succeeded' | 'failed';
/** One file for `submitBatch`. The filename's extension sets the media type. */
export interface BatchItem {
  filename: string;
  /** The file's bytes, or a path to read it from. */
  file: Uint8Array | string;
  /** Forensic data to embed (non-empty, up to 8 KB as JSON). */
  data: Record<string, JsonValue>;
}
/** One zip member for `submitBatchZip`: its exact path inside the zip and its data. */
export interface ZipBatchItem { filename: string; data: Record<string, JsonValue> }
export interface BatchOptions extends CallOptions {
  /** Also zip every result into one download (`downloadBatchArchive`). Not with `storageDestinationId`. */
  archive?: boolean;
  /** Enabled webhook endpoint (`wh_…`) that receives one `watermark.batch.*` event when the batch ends. */
  webhookId?: string;
  /** `'gpu'` requests GPU processing for every file (see `RequestOptions.accelerator`). */
  accelerator?: Accelerator;
  /** Deliver every result to this verified storage destination (`dst_…`). */
  storageDestinationId?: string;
  /** 8–128 letters, digits, hyphens or underscores. Generated when omitted; reuse it to resume a batch. */
  idempotencyKey?: string;
  /** Files uploaded at once (1–16, default 4). */
  uploadConcurrency?: number;
}
export interface WaitForBatchOptions {
  /** Abort the wait. */
  signal?: AbortSignal;
  /** Whole wait in milliseconds (default one hour). */
  timeout?: number;
  /** Minimum milliseconds between polls; `Retry-After` from the API is always honored. */
  pollInterval?: number;
}
/** One file of a batch as the API reports it. */
export interface BatchEntry {
  index: number; filename: string; size: number | null; upload_id: string | null; request_id: string | null;
  status: BatchItemStatus;
  /** Why a `rejected` or `failed` item has no result, e.g. `upload_not_received`, `invalid_input`, `insufficient_credits`, `cancelled`. */
  error_code: string | null; error_detail: string | null;
  /** Credits charged once accepted (0 when refunded). */
  credits: number | null;
  status_url?: string; result_url?: string; result_expires_at?: string | null;
  /** Signed upload URL, only on pending items of a draft whose file has not arrived. Never send the API key to it. */
  upload?: { method: 'PUT'; url: string; expires_at: string };
  /** True on a replayed draft when this file already arrived. */
  upload_received?: boolean;
}
export interface Batch {
  batch_id: string; status: BatchStatus; item_count: number; archive: boolean; accelerator: Accelerator;
  webhook_id: string | null; storage_destination_id: string | null;
  counts: { pending: number; accepted: number; rejected: number; succeeded: number; failed: number; in_progress: number };
  credits: { reserved: number; charged: number; refunded: number };
  cancel_requested: boolean; created_at: string; started_at: string | null; completed_at: string | null;
  upload_expires_at: string; status_url: string;
  /** Set when the batch was created with `archive: true`. */
  archive_status?: string | null; archive_url?: string; archive_expires_at?: string | null;
  /** Every file; absent in `listBatches` pages. */
  items?: BatchEntry[];
}
export interface BatchPage { data: Batch[]; next_cursor: string | null }
/** One item from `iterBatchResults`: the verified file (`ok: true`), or why there is none. */
export type BatchItemResult = { index: number; filename: string; status: BatchItemStatus; requestId: string | null } & (
  | { ok: true; result: EmbedResult; errorCode: null; errorDetail: null }
  /** `errorCode` explains the missing result; its credits were refunded or never charged. */
  | { ok: false; result: null; errorCode: string; errorDetail: string | null }
);

export interface EtchvOptions {
  /** Organization API key, sent as `X-API-Key`. */
  apiKey: string;
  /** API origin (default `https://api.etchv.com`). HTTPS only, except localhost. */
  baseUrl?: string;
  /** Per-call deadline in milliseconds (default 120000). */
  timeout?: number;
  /** Custom fetch implementation, e.g. for tests. */
  fetch?: typeof globalThis.fetch;
  /** Files above this many bytes go through an upload session instead of the request body (default 40 MB). */
  largeFileThreshold?: number;
}

export type UploadKind = 'image' | 'document' | 'video' | 'detect';
export interface UploadSession {
  upload_id: string; kind: UploadKind; filename: string; size: number;
  status: 'pending' | 'received' | 'consumed' | 'rejected' | 'expired'; expires_at: string;
}

/** Server-side Etchv API client. */
export declare class Etchv {
  constructor(options: EtchvOptions);

  /**
   * Upload a file once to a signed URL; pass the returned `upload_id` instead of the file.
   * Embed and detect methods do this automatically above `largeFileThreshold`.
   */
  uploadFile(kind: UploadKind, file: Uint8Array, options?: CallOptions & { filename?: string }): Promise<UploadSession>;

  /** Validate the API key without consuming credits (`GET /auth/api-key`). */
  getApiKeyInfo(options?: CallOptions): Promise<ApiKeyInfo>;

  /** Watermark an image and wait for the verified file. Retries transient failures and polls with the same idempotency key. */
  embedImage(image: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions): Promise<EmbedResult>;
  /** Watermark a PDF and wait for the verified file. */
  embedDocument(document: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions): Promise<EmbedResult>;
  /** Watermark an MP4/MOV video and wait for the verified file. */
  embedVideo(video: Uint8Array, data: Record<string, JsonValue>, options?: RequestOptions): Promise<EmbedResult>;
  /** Detect an image watermark (synchronous; not retried). */
  detectImage(image: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  /** Detect PDF watermarks page by page (synchronous; not retried). */
  detectDocument(document: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  /** Detect video watermarks; waits for the durable detection job. */
  detectVideo(video: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;

  /** Submit an async embedding job; resolves with the `202` receipt. */
  submitEmbed(media: Media, file: Uint8Array, data: Record<string, JsonValue>, options?: AsyncOptions): Promise<Job>;
  /** Submit an async detection job; resolves with the `202` receipt. Storage options are not accepted. */
  submitDetection(media: Media, file: Uint8Array, options?: Omit<AsyncOptions, 'storageDestinationId' | 'storageKey'>): Promise<Job>;
  /** Read an embedding job, or a detection job with `detect: true`. */
  getJob(requestId: string, options?: CallOptions & { detect?: boolean }): Promise<Job>;
  /** Wait for and download an embedding job's result. Rejects with `GoneError` if expired or deleted. */
  getEmbedResult(requestId: string, options?: CallOptions): Promise<EmbedResult>;
  /** Wait for a detection job's result. Rejects with `GoneError` if expired. */
  getDetectionResult(requestId: string, options?: CallOptions): Promise<DetectionResult>;

  /**
   * Watermark up to 100 files as one batch: create, upload each file to its signed URL
   * (without the API key), start. Resolves with the started batch. More than 100 items
   * rejects with a `RangeError` before any request.
   */
  submitBatch(items: BatchItem[], options?: BatchOptions): Promise<Batch>;
  /** Create and start a batch from one zip (up to 55 MB) whose members are all listed in `items`. */
  submitBatchZip(zip: Uint8Array | string, items: ZipBatchItem[], options?: Omit<BatchOptions, 'uploadConcurrency'>): Promise<Batch>;
  /** Read a batch with every item's status. */
  getBatch(batchId: string, options?: CallOptions): Promise<Batch>;
  /** Poll until the batch is final, honoring `Retry-After`. Rejects with `EtchvTimeoutError` after `timeout`. */
  waitForBatch(batchId: string, options?: WaitForBatchOptions): Promise<Batch>;
  /** Wait for the batch, then yield each item's verified file or error code, in order. */
  iterBatchResults(batchId: string, options?: WaitForBatchOptions): AsyncIterable<BatchItemResult>;
  /**
   * Wait for and download the batch zip (`archive: true`). `timeout` bounds the wait; the
   * download fails only when no data arrives for the client timeout. Rejects with
   * `ConflictError` (`archive_not_requested`, `batch_not_started`, `archive_too_large`,
   * `archive_unavailable`) or `GoneError`.
   */
  downloadBatchArchive(batchId: string, options?: Omit<WaitForBatchOptions, 'pollInterval'>): Promise<Uint8Array>;
  /** Stream the batch zip to a file path (through a `.part` file) or a writable stream; resolves with the bytes written. */
  downloadBatchArchiveTo(batchId: string, destination: string | NodeJS.WritableStream, options?: Omit<WaitForBatchOptions, 'pollInterval'>): Promise<number>;
  /** Cancel a batch: files still waiting fail with error code `cancelled` and are refunded; queued and running files finish. */
  cancelBatch(batchId: string, options?: CallOptions): Promise<Batch>;
  /** List batches newest first (without items). */
  listBatches(options?: CallOptions & { limit?: number; before?: string }): Promise<BatchPage>;

  listAssets(options?: ListAssetsOptions): Promise<AssetPage>;
  getAsset(id: string, options?: CallOptions & { includeMetadata?: boolean }): Promise<Asset>;
  /** Rename or replace metadata. A stale `version` rejects with `ConflictError`. */
  updateAsset(id: string, changes: AssetUpdate, options?: CallOptions): Promise<Asset>;
  deleteAsset(id: string, options?: CallOptions): Promise<void>;
  /** Atomically delete 1–50 assets. */
  deleteAssets(ids: string[], options?: CallOptions): Promise<void>;
  /** Download an asset file. Rejects with `GoneError` after its availability window. */
  downloadAsset(id: string, options?: CallOptions): Promise<Uint8Array>;

  listWebhooks(options?: CallOptions): Promise<WebhookEndpoint[]>;
  /** Create an endpoint. The one-time `signing_secret` is only returned here. */
  createWebhook(endpoint: { url: string }, options?: CallOptions): Promise<CreatedWebhookEndpoint>;
  updateWebhook(id: string, changes: { enabled: boolean }, options?: CallOptions): Promise<WebhookEndpoint>;
  deleteWebhook(id: string, options?: CallOptions): Promise<void>;
  listWebhookDeliveries(id: string, options?: CallOptions & { after?: string }): Promise<WebhookDeliveryPage>;
  redeliverWebhookEvent(id: string, eventId: string, options?: CallOptions): Promise<{ id: string; status: 'queued' }>;

  listStorageDestinations(options?: CallOptions): Promise<StorageDestination[]>;
  createStorageDestination(destination: StorageDestinationCreate, options?: CallOptions): Promise<StorageDestination>;
  updateStorageDestination(id: string, changes: StorageDestinationUpdate, options?: CallOptions): Promise<StorageDestination>;
  deleteStorageDestination(id: string, options?: CallOptions): Promise<void>;
  verifyStorageDestination(id: string, options?: CallOptions): Promise<StorageDestination>;
  listStorageDeliveries(destinationId: string, options?: CallOptions & { after?: string }): Promise<StorageDeliveryPage>;
  createStorageDelivery(destinationId: string, assetId: string, options?: CallOptions & { key?: string }): Promise<StorageDelivery>;
  /** Read a delivery. Returns 404 until the watermark job succeeds. */
  getStorageDelivery(id: string, options?: CallOptions): Promise<StorageDelivery>;
  retryStorageDelivery(id: string, options?: CallOptions): Promise<StorageDelivery>;
  downloadStorageDelivery(id: string, options?: CallOptions): Promise<Uint8Array>;
}

/** Thrown by `parseWebhookEvent` for an invalid, stale or malformed delivery. */
export declare class WebhookVerificationError extends Error {}
/** Verify `X-Etchv-Signature` over the raw body. Returns false for any invalid delivery. */
export declare function verifyWebhookSignature(payload: WebhookPayload, headers: WebhookHeaders, signingSecret: string, options?: WebhookVerifyOptions): boolean;
/** Verify, parse and check the event ID of a webhook delivery. Throws `WebhookVerificationError`. */
export declare function parseWebhookEvent(payload: WebhookPayload, headers: WebhookHeaders, signingSecret: string, options?: WebhookVerifyOptions): WebhookEvent;
