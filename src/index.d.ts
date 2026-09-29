/** SDK version. Sent in the `User-Agent` header of every request. */
export declare const VERSION: string;

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
  | 'storage.delivery.succeeded' | 'storage.delivery.failed';
export interface StorageDeliveryEventData {
  delivery_id: string; asset_id: string; request_id: string; destination_id: string;
  status: string; error_code: string | null; uri: string | null; public_url: string | null;
}
/** Verified webhook event. Watermark events carry a job receipt plus `watermark_id`. */
export interface WebhookEvent {
  id: string; type: WebhookEventType | (string & {}); api_version: string; created_at: string;
  data: (Job & { watermark_id: string | null }) | StorageDeliveryEventData | Record<string, JsonValue>;
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

export interface EtchvOptions {
  /** Organization API key, sent as `X-API-Key`. */
  apiKey: string;
  /** API origin (default `https://api.etchv.com`). HTTPS only, except localhost. */
  baseUrl?: string;
  /** Per-call deadline in milliseconds (default 120000). */
  timeout?: number;
  /** Custom fetch implementation, e.g. for tests. */
  fetch?: typeof globalThis.fetch;
}

/** Server-side Etchv API client. */
export declare class Etchv {
  constructor(options: EtchvOptions);

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
