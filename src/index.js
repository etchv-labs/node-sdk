import { createHmac, timingSafeEqual } from 'node:crypto';

/** SDK version. Sent in the `User-Agent` header of every request. */
export const VERSION = '1.0.2';

const MEDIA = ['images', 'documents', 'videos'];
const FILENAMES = { images: 'image.png', documents: 'document.pdf', videos: 'video.mp4' };
const DURABLE = ['watermarks/images', 'watermarks/documents', 'watermarks/videos', 'watermarks/videos/detect'];
const IDS = {
  request: [/^req_[a-f0-9]{64}$/, 'request ID'], asset: [/^ast_[a-f0-9]{64}$/, 'asset ID'],
  webhook: [/^wh_[a-f0-9]{32}$/, 'webhook ID'], event: [/^evt_[a-f0-9]{64}$/, 'webhook event ID'],
  destination: [/^dst_[a-f0-9]{32}$/, 'storage destination ID'], delivery: [/^std_[a-f0-9]{64}$/, 'storage delivery ID'],
};
const SECRET_TEXT = /\b(?:etchv|whsec|sk_live|sk_test)_[A-Za-z0-9_+/=-]+/g;

function errorMessage(statusCode, detail) {
  const base = statusCode === 0 ? 'Etchv request timed out' : `Etchv request failed (HTTP ${statusCode})`;
  const text = typeof detail === 'string' ? detail
    : typeof detail?.detail === 'string' ? detail.detail : typeof detail?.message === 'string' ? detail.message : '';
  // Never echo credentials or markup from an unexpected response into an error message.
  const safe = text.includes('<') ? '' : text.replace(SECRET_TEXT, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 200);
  return safe ? `${base}: ${safe}` : base;
}

/**
 * HTTP or protocol failure returned by the Etchv API. Subclasses identify common
 * statuses; all of them carry the HTTP `statusCode`, parsed `detail` and the
 * `X-Request-ID` (`requestId`) to quote when contacting support.
 */
export class EtchvError extends Error {
  constructor(statusCode, detail, requestId = null) {
    super(errorMessage(statusCode, detail));
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.detail = detail;
    this.requestId = requestId;
  }
}
/** HTTP 401: missing, invalid, expired or inactive API key. */
export class AuthenticationError extends EtchvError {}
/** HTTP 402: billing or credits unavailable. */
export class PaymentRequiredError extends EtchvError {}
/** HTTP 403: the key lacks a scope, membership role or plan access. */
export class PermissionDeniedError extends EtchvError {}
/** HTTP 404: the resource does not exist in the key's organization. */
export class NotFoundError extends EtchvError {}
/** HTTP 409: idempotency conflict, stale version or conflicting state. */
export class ConflictError extends EtchvError {}
/** HTTP 410: a saved job result or asset file expired or was deleted. */
export class GoneError extends EtchvError {}
/** HTTP 413 or 422: the upload, forensic data or request body is invalid. */
export class InvalidRequestError extends EtchvError {}
/** HTTP 429: too many requests. */
export class RateLimitError extends EtchvError {}
/** HTTP 5xx: the service or a dependency is unavailable. */
export class ServiceUnavailableError extends EtchvError {}
/** The client deadline passed (`statusCode` 0). A durable job may still complete. */
export class EtchvTimeoutError extends EtchvError {}

const ERRORS = {
  401: AuthenticationError, 402: PaymentRequiredError, 403: PermissionDeniedError, 404: NotFoundError,
  409: ConflictError, 410: GoneError, 413: InvalidRequestError, 422: InvalidRequestError, 429: RateLimitError,
};
function errorFor(statusCode, detail, requestId) {
  const Type = ERRORS[statusCode] || (statusCode >= 500 ? ServiceUnavailableError : EtchvError);
  return new Type(statusCode, detail, requestId);
}

function checkId(kind, value) {
  const [pattern, label] = IDS[kind];
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid ${label}`);
  return value;
}

function encodeJson(value, message = 'Request body must contain finite JSON values') {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'function' || typeof item === 'symbol' || typeof item === 'bigint' ||
      (typeof item === 'number' && !Number.isFinite(item))) throw new TypeError(message);
    return item;
  });
}

function encodeData(data) {
  if (!data || Object.getPrototypeOf(data) !== Object.prototype || !Object.keys(data).length) {
    throw new TypeError('data must be a non-empty JSON object');
  }
  return JSON.stringify(data, (_key, value) => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
        (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('data must contain JSON values');
    return value;
  });
}

const callOptions = ({ signal, timeout } = {}) => ({ signal, timeout });

/**
 * Server-side client for the Etchv API. Authenticates with an `X-API-Key`.
 * Keep API keys on your server; this client is not intended for browsers.
 */
export class Etchv {
  #apiKey;
  #baseUrl;
  #timeout;
  #fetch;
  #userAgent;
  /**
   * @param {object} options
   * @param {string} options.apiKey Organization API key.
   * @param {string} [options.baseUrl] API origin (default `https://api.etchv.com`). HTTPS only, except localhost.
   * @param {number} [options.timeout] Per-call deadline in milliseconds (default 120000).
   * @param {typeof fetch} [options.fetch] Custom fetch implementation, e.g. for tests.
   */
  constructor({ apiKey, baseUrl = 'https://api.etchv.com', timeout = 120000, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('apiKey is required');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new TypeError('baseUrl must use HTTPS (HTTP is allowed for localhost)');
    }
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '') + '/';
    this.#timeout = timeout;
    this.#fetch = fetchImpl;
    this.#userAgent = `etchv-node/${VERSION}` + (globalThis.process?.version ? ` node/${globalThis.process.version}` : '');
  }

  #headers(extra = {}) {
    return { 'X-API-Key': this.#apiKey, 'User-Agent': this.#userAgent, ...extra };
  }

  async #post(path, file, { filename = 'image.png', idempotencyKey, storageDestinationId, storageKey, signal, timeout } = {}, data) {
    if (!(file instanceof Uint8Array) || !file.byteLength || file.byteLength > 20 * 1024 * 1024) {
      throw new TypeError('file must be a Buffer or Uint8Array containing 1 byte to 20 MB');
    }
    if (typeof filename !== 'string' || !filename) throw new TypeError('filename must be a non-empty string');
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(idempotencyKey))) {
      throw new TypeError('idempotencyKey must contain 8–128 letters, digits, hyphens or underscores');
    }
    if (storageKey != null && !storageDestinationId) throw new TypeError('storageKey requires storageDestinationId');
    if (storageDestinationId != null) {
      if (data === undefined || !IDS.destination[0].test(storageDestinationId)) throw new TypeError('Invalid storage destination or detection request');
      if (storageKey != null && (typeof storageKey !== 'string' || !storageKey)) throw new TypeError('storageKey must be a non-empty string');
      const params = new URLSearchParams({ storage_destination_id: storageDestinationId });
      if (storageKey != null) params.set('storage_key', storageKey);
      path += (path.includes('?') ? '&' : '?') + params;
    }
    const form = new FormData();
    form.append('file', new Blob([file], { type: 'application/octet-stream' }), filename);
    if (data !== undefined) form.append('data', data);
    const route = path.split('?')[0];
    const accepted = route.endsWith('/async');
    const durable = accepted || DURABLE.includes(route);
    const headers = this.#headers();
    const key = idempotencyKey ?? (durable ? globalThis.crypto.randomUUID() : undefined);
    if (key !== undefined) headers['Idempotency-Key'] = key;
    return this.#request(path, { method: 'POST', headers, body: form }, { durable, accepted, idempotencyKey: key, signal, timeout });
  }

  async #request(path, init, { durable = false, accepted = false, idempotencyKey, signal, timeout = this.#timeout } = {}) {
    if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    signal?.throwIfAborted();
    const detectionJob = path.startsWith('watermarks/videos/detect') || path.includes('detection-jobs/');
    const deadline = Date.now() + timeout;
    let requestId = path.match(/watermarks\/(?:detection-)?jobs\/(req_[a-f0-9]{64})/)?.[1] || null;
    const expired = () => new EtchvTimeoutError(0, durable
      ? { message: 'Client deadline exceeded; the job may still complete', idempotencyKey }
      : { message: 'Client deadline exceeded' }, requestId);
    const pause = (seconds = 1) => new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); },
        Math.min(seconds * 1000, Math.max(0, deadline - Date.now())));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    while (Date.now() < deadline) {
      let response;
      let body;
      try {
        // A referenced timer, unlike AbortSignal.timeout(), keeps Node alive until the
        // deadline fires, so a stalled request always ends in a timeout error.
        const limit = new AbortController();
        const timer = setTimeout(() => limit.abort(new DOMException('Client deadline exceeded', 'TimeoutError')),
          Math.max(1, deadline - Date.now()));
        try {
          response = await this.#fetch(new URL(path, this.#baseUrl), {
            ...init, redirect: 'manual', signal: signal ? AbortSignal.any([signal, limit.signal]) : limit.signal,
          });
          requestId = response.headers.get('x-request-id') || requestId;
          body = await response.arrayBuffer();
        } finally {
          clearTimeout(timer);
        }
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.name === 'TimeoutError' || Date.now() >= deadline) throw expired();
        if (!durable) throw error;
        await pause();
        continue;
      }
      if ([200, 201, 204].includes(response.status) || (accepted && response.status === 202)) {
        return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
      }
      let detail = new TextDecoder().decode(body).slice(0, 10000);
      try { detail = JSON.parse(detail); } catch { /* Preserve error text. */ }
      if (durable && response.status === 202) {
        if (!detail || typeof detail !== 'object' || !IDS.request[0].test(detail.request_id)) {
          throw new EtchvError(202, 'Invalid job response', requestId);
        }
        requestId = detail.request_id;
        // Construct a trusted local path; never send API keys to a server-supplied URL.
        path = `watermarks/${detectionJob ? 'detection-jobs' : 'jobs'}/${requestId}/result`;
        init = { method: 'GET', headers: this.#headers() };
        const wait = Number(response.headers.get('retry-after') || 1);
        await pause(Number.isFinite(wait) ? Math.min(5, Math.max(0.01, wait)) : 1);
        continue;
      }
      if (durable && [429, 502, 503, 504].includes(response.status) && detail?.status !== 'failed') {
        await pause();
        continue;
      }
      throw errorFor(response.status, detail, requestId);
    }
    throw expired();
  }

  async #call(path, { method = 'GET', body, accepted = false, signal, timeout } = {}) {
    const headers = this.#headers(body === undefined ? {} : { 'Content-Type': 'application/json' });
    return this.#request(path, { method, headers, ...(body === undefined ? {} : { body: encodeJson(body) }) },
      { accepted, signal, timeout });
  }

  async #json(path, options) {
    const response = await this.#call(path, options);
    if (response.status === 204) return undefined;
    try { return await response.json(); } catch {
      throw new EtchvError(response.status, 'Invalid JSON response', response.headers.get('x-request-id'));
    }
  }

  async #bytes(path, options) {
    return new Uint8Array(await (await this.#call(path, options)).arrayBuffer());
  }

  #asyncPath(media, detect, webhookId) {
    if (!MEDIA.includes(media)) throw new TypeError('media must be images, documents or videos');
    if (webhookId != null) checkId('webhook', webhookId);
    return `watermarks/${media}${detect ? '/detect' : ''}/async${webhookId ? '?webhook_id=' + webhookId : ''}`;
  }

  // Connection check

  /** Validate the API key without consuming credits. Returns its organization, key ID and scopes. */
  async getApiKeyInfo(options = {}) {
    return this.#json('auth/api-key', callOptions(options));
  }

  // Async jobs

  /** Submit a durable embedding job and return its `202` receipt without waiting for processing. */
  async submitEmbed(media, file, data, { webhookId, ...options } = {}) {
    const body = encodeData(data);
    const path = this.#asyncPath(media, false, webhookId);
    return (await this.#post(path, file, { filename: FILENAMES[media], ...options }, body)).json();
  }
  /** Submit a durable detection job and return its `202` receipt without waiting for processing. */
  async submitDetection(media, file, { webhookId, ...options } = {}) {
    const path = this.#asyncPath(media, true, webhookId);
    if (options.storageDestinationId != null || options.storageKey != null) throw new TypeError('Storage destinations apply to embedding jobs only');
    return (await this.#post(path, file, { filename: FILENAMES[media], ...options })).json();
  }
  /** Read the status of an embedding job, or a detection job with `{ detect: true }`. */
  async getJob(requestId, { detect = false, ...options } = {}) {
    checkId('request', requestId);
    return this.#json(`watermarks/${detect ? 'detection-jobs' : 'jobs'}/${requestId}`, callOptions(options));
  }
  /** Wait for an embedding job and return its verified file. Throws `GoneError` (410) if the result expired or was deleted. */
  async getEmbedResult(requestId, options = {}) {
    checkId('request', requestId);
    return this.#embeddingResult(await this.#request(`watermarks/jobs/${requestId}/result`,
      { method: 'GET', headers: this.#headers() }, { durable: true, ...callOptions(options) }));
  }
  /** Wait for a detection job and return its result. Throws `GoneError` (410) if the result expired. */
  async getDetectionResult(requestId, options = {}) {
    checkId('request', requestId);
    return this.#detectionResult(await this.#request(`watermarks/detection-jobs/${requestId}/result`,
      { method: 'GET', headers: this.#headers() }, { durable: true, ...callOptions(options) }));
  }

  // Assets

  /** List assets, newest first. Pass `cursor: page.next_cursor` with the same filters for the next page. */
  async listAssets({ limit = 25, cursor, kind, mediaType, watermarkId, ...options } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
    const params = new URLSearchParams({ limit: String(limit) });
    for (const [key, value] of Object.entries({ cursor, kind, media_type: mediaType, watermark_id: watermarkId })) if (value != null) params.set(key, value);
    return this.#json(`assets?${params}`, callOptions(options));
  }
  /** Read an asset record. */
  async getAsset(id, { includeMetadata, ...options } = {}) {
    const query = includeMetadata === false ? '?include_metadata=false' : '';
    return this.#json(`assets/${checkId('asset', id)}${query}`, callOptions(options));
  }
  /** Rename an asset or replace its metadata. Requires the current `version`; a stale version returns 409. */
  async updateAsset(id, changes, options = {}) {
    checkId('asset', id);
    if (!changes || typeof changes !== 'object' || !Number.isSafeInteger(changes.version)) throw new TypeError('changes must include the current version');
    return this.#json(`assets/${id}`, { method: 'PATCH', body: changes, ...callOptions(options) });
  }
  /** Delete an asset. */
  async deleteAsset(id, options = {}) {
    await this.#call(`assets/${checkId('asset', id)}`, { method: 'DELETE', ...callOptions(options) });
  }
  /** Atomically delete 1–50 assets. */
  async deleteAssets(ids, options = {}) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw new TypeError('Provide 1–50 asset IDs');
    ids.forEach(id => checkId('asset', id));
    await this.#call('assets/bulk-delete', { method: 'POST', body: { asset_ids: ids }, ...callOptions(options) });
  }
  /** Download an asset's file. Throws `GoneError` (410) after its availability window. */
  async downloadAsset(id, options = {}) {
    return this.#bytes(`assets/${checkId('asset', id)}/content`, callOptions(options));
  }

  // Webhooks

  /** List webhook endpoints (up to 10). */
  async listWebhooks(options = {}) {
    return this.#json('webhooks', callOptions(options));
  }
  /** Create a webhook endpoint. The response includes a one-time `signing_secret`; store it securely. */
  async createWebhook({ url } = {}, options = {}) {
    if (typeof url !== 'string' || !url.startsWith('https://')) throw new TypeError('url must be a public HTTPS URL');
    return this.#json('webhooks', { method: 'POST', body: { url }, ...callOptions(options) });
  }
  /** Enable or disable a webhook endpoint. */
  async updateWebhook(id, { enabled } = {}, options = {}) {
    checkId('webhook', id);
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return this.#json(`webhooks/${id}`, { method: 'PATCH', body: { enabled }, ...callOptions(options) });
  }
  /** Permanently delete a webhook endpoint. */
  async deleteWebhook(id, options = {}) {
    await this.#call(`webhooks/${checkId('webhook', id)}`, { method: 'DELETE', ...callOptions(options) });
  }
  /** List recent deliveries for an endpoint (50 per page). Pass `after: page.next_cursor` for the next page. */
  async listWebhookDeliveries(id, { after, ...options } = {}) {
    checkId('webhook', id);
    if (after != null) checkId('event', after);
    return this.#json(`webhooks/${id}/deliveries${after ? '?after=' + after : ''}`, callOptions(options));
  }
  /** Queue a delivered, exhausted or cancelled event for redelivery. */
  async redeliverWebhookEvent(id, eventId, options = {}) {
    checkId('webhook', id); checkId('event', eventId);
    return this.#json(`webhooks/${id}/deliveries/${eventId}/redeliver`, { method: 'POST', accepted: true, ...callOptions(options) });
  }

  // Storage destinations and deliveries

  /** List customer storage destinations (up to 10). */
  async listStorageDestinations(options = {}) {
    return this.#json('storage/destinations', callOptions(options));
  }
  /** Create a storage destination. Credentials are sent once and never returned. */
  async createStorageDestination(destination, options = {}) {
    if (!destination || typeof destination !== 'object') throw new TypeError('destination must be an object');
    return this.#json('storage/destinations', { method: 'POST', body: destination, ...callOptions(options) });
  }
  /** Enable/disable a destination or replace its credentials (which clears verification). */
  async updateStorageDestination(id, changes, options = {}) {
    checkId('destination', id);
    if (!changes || typeof changes !== 'object') throw new TypeError('changes must be an object');
    return this.#json(`storage/destinations/${id}`, { method: 'PATCH', body: changes, ...callOptions(options) });
  }
  /** Disconnect a destination and discard its stored credentials. */
  async deleteStorageDestination(id, options = {}) {
    await this.#call(`storage/destinations/${checkId('destination', id)}`, { method: 'DELETE', ...callOptions(options) });
  }
  /** Write and read a connection probe; returns the verified destination. */
  async verifyStorageDestination(id, options = {}) {
    return this.#json(`storage/destinations/${checkId('destination', id)}/verify`, { method: 'POST', ...callOptions(options) });
  }
  /** List deliveries to a destination (50 per page). Pass `after: page.next_cursor` for the next page. */
  async listStorageDeliveries(destinationId, { after, ...options } = {}) {
    checkId('destination', destinationId);
    if (after != null) checkId('delivery', after);
    return this.#json(`storage/destinations/${destinationId}/deliveries${after ? '?after=' + after : ''}`, callOptions(options));
  }
  /** Move an Etchv-hosted watermarked asset to a destination, optionally at a relative object `key`. */
  async createStorageDelivery(destinationId, assetId, { key, ...options } = {}) {
    checkId('destination', destinationId); checkId('asset', assetId);
    if (key != null && (typeof key !== 'string' || !key)) throw new TypeError('key must be a non-empty string');
    return this.#json(`storage/destinations/${destinationId}/deliveries`,
      { method: 'POST', accepted: true, body: { asset_id: assetId, ...(key != null ? { key } : {}) }, ...callOptions(options) });
  }
  /** Read a storage delivery. Returns 404 until the watermark job succeeds. */
  async getStorageDelivery(id, options = {}) {
    return this.#json(`storage/deliveries/${checkId('delivery', id)}`, callOptions(options));
  }
  /** Retry a failed or cancelled upload without another charge. */
  async retryStorageDelivery(id, options = {}) {
    return this.#json(`storage/deliveries/${checkId('delivery', id)}/retry`, { method: 'POST', accepted: true, ...callOptions(options) });
  }
  /** Download a stored object through Etchv, verified against the asset checksum. */
  async downloadStorageDelivery(id, options = {}) {
    return this.#bytes(`storage/deliveries/${checkId('delivery', id)}/content`, callOptions(options));
  }

  // Synchronous watermarking

  /** Watermark an image and wait for the verified file in its original format. */
  async embedImage(image, data, options = {}) { return this.#embed('images', image, data, options); }
  /** Watermark a PDF and wait for the verified file. */
  async embedDocument(document, data, options = {}) { return this.#embed('documents', document, data, { filename: 'document.pdf', ...options }); }
  /** Watermark an MP4/MOV video and wait for the verified file. */
  async embedVideo(video, data, options = {}) { return this.#embed('videos', video, data, { filename: 'video.mp4', ...options }); }
  async #embed(media, file, data, options) {
    const response = await this.#post(`watermarks/${media}`, file, options, encodeData(data));
    return this.#embeddingResult(response);
  }
  async #embeddingResult(response) {
    const watermarkId = response.headers.get('x-watermark-id');
    const requestId = response.headers.get('x-request-id');
    const result = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0];
    const extension = fileExtension(result, contentType);
    if (!extension || !validId(watermarkId)) {
      throw new EtchvError(200, 'Invalid embedding response', requestId);
    }
    const filename = response.headers.get('content-disposition')?.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] || `image-watermarked.${extension}`;
    return { image: result, watermarkId, requestId, contentType, filename, assetId: response.headers.get('x-asset-id'), sourceAssetId: response.headers.get('x-source-asset-id'), storageDeliveryId: response.headers.get('x-storage-delivery-id') };
  }

  // Synchronous detection

  /** Detect a watermark in an image. Not retried automatically. */
  async detectImage(image, options = {}) { return this.#detect('images', image, options); }
  /** Detect watermarks in each page of a PDF. Not retried automatically. */
  async detectDocument(document, options = {}) { return this.#detect('documents', document, { filename: 'document.pdf', ...options }); }
  /** Detect watermarks in a video; waits for the durable detection job. */
  async detectVideo(video, options = {}) { return this.#detect('videos', video, { filename: 'video.mp4', ...options }); }
  async #detect(media, file, options) {
    if (options.storageDestinationId != null || options.storageKey != null) throw new TypeError('Storage destinations apply to embedding jobs only');
    return this.#detectionResult(await this.#post(`watermarks/${media}/detect`, file, options));
  }
  async #detectionResult(response) {
    const requestId = response.headers.get('x-request-id');
    let result;
    try { result = await response.json(); } catch { throw new EtchvError(200, 'Invalid detection response', requestId); }
    if (!result || typeof result.watermarked !== 'boolean' || typeof result.confidence !== 'number' ||
        !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
        (result.watermarked ? !validId(result.watermark_id) : result.watermark_id !== null)) {
      throw new EtchvError(200, 'Invalid detection response', requestId);
    }
    const rawUnits = result.units ?? [{ index: 0, ...result }];
    if (!Array.isArray(rawUnits) || !rawUnits.length || rawUnits.some((unit, index) =>
      !unit || unit.index !== index || typeof unit.watermarked !== 'boolean' ||
      typeof unit.confidence !== 'number' || !Number.isFinite(unit.confidence) || unit.confidence < 0 || unit.confidence > 1 ||
      (unit.watermarked ? !validId(unit.watermark_id) : unit.watermark_id !== null))) {
      throw new EtchvError(200, 'Invalid detection units', requestId);
    }
    const units = rawUnits.map(unit => ({ index: unit.index, watermarked: unit.watermarked, confidence: unit.confidence, watermarkId: unit.watermark_id }));
    return { watermarked: result.watermarked, confidence: result.confidence, watermarkId: result.watermark_id, requestId, units };
  }
}

const validId = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

function fileExtension(bytes, mime) {
  const starts = (signature, offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (text, offset = 0) => starts(Array.from(text, c => c.charCodeAt(0)), offset);
  if ((mime === 'video/mp4' || mime === 'video/quicktime') && ascii('ftyp', 4)) return mime === 'video/mp4' ? 'mp4' : 'mov';
  if (mime === 'application/pdf' && ascii('%PDF-')) return 'pdf';
  if (mime === 'image/png' && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (mime === 'image/jpeg' && starts([255, 216, 255])) return 'jpg';
  if (mime === 'image/gif' && (ascii('GIF87a') || ascii('GIF89a'))) return 'gif';
  if (mime === 'image/tiff' && (starts([73, 73, 42, 0]) || starts([77, 77, 0, 42]))) return 'tiff';
  if (mime === 'image/bmp' && ascii('BM')) return 'bmp';
  if (mime === 'image/x-portable-pixmap' && (ascii('P6') || ascii('P3'))) return 'ppm';
  if (mime === 'image/webp' && ascii('RIFF') && ascii('WEBP', 8)) return 'webp';
  if (mime === 'image/vnd.adobe.photoshop' && ascii('8BPS') && bytes[4] === 0) return ({ 1: 'psd', 2: 'psb' })[bytes[5]];
  return null;
}

// Webhook signatures

/** Raised by `parseWebhookEvent` when a delivery is unsigned, stale, tampered with or malformed. */
export class WebhookVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

function webhookHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function rawBytes(payload) {
  if (typeof payload === 'string') return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw new TypeError('payload must be the raw request body as a string, Buffer or Uint8Array');
}

/**
 * Verify an Etchv webhook delivery: HMAC-SHA256 of `timestamp + "." + rawBody`
 * keyed with the endpoint's full `whsec_` signing secret, compared in constant
 * time, with a timestamp tolerance (default 300 seconds). Pass the raw body
 * bytes before parsing JSON. Returns `false` for any invalid delivery.
 */
export function verifyWebhookSignature(payload, headers, signingSecret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  const body = rawBytes(payload);
  if (typeof signingSecret !== 'string' || !signingSecret) throw new TypeError('signingSecret is required');
  const timestamp = webhookHeader(headers, 'X-Etchv-Timestamp');
  const signature = webhookHeader(headers, 'X-Etchv-Signature');
  if (typeof timestamp !== 'string' || !/^\d{1,12}$/.test(timestamp) || typeof signature !== 'string') return false;
  if (!(Math.abs(now / 1000 - Number(timestamp)) <= toleranceSeconds)) return false;
  const expected = new TextEncoder().encode('v1=' + createHmac('sha256', signingSecret).update(timestamp + '.').update(body).digest('hex'));
  return signature.split(/[\s,]+/).some(candidate => {
    const given = new TextEncoder().encode(candidate);
    return given.byteLength === expected.byteLength && timingSafeEqual(given, expected);
  });
}

/**
 * Verify a webhook delivery, parse its JSON and check that the body `id`
 * matches `X-Etchv-Event-ID`. Throws `WebhookVerificationError` on failure.
 * Deduplicate processed events by `event.id`.
 */
export function parseWebhookEvent(payload, headers, signingSecret, options = {}) {
  const body = rawBytes(payload);
  if (!verifyWebhookSignature(body, headers, signingSecret, options)) throw new WebhookVerificationError('Invalid or expired webhook signature');
  let event;
  try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); } catch { throw new WebhookVerificationError('Webhook body is not valid JSON'); }
  if (!event || typeof event !== 'object' || typeof event.id !== 'string' || event.id !== webhookHeader(headers, 'X-Etchv-Event-ID')) {
    throw new WebhookVerificationError('Webhook event ID does not match X-Etchv-Event-ID');
  }
  return event;
}
