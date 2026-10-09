import { createHmac, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';

/** SDK version. Sent in the `User-Agent` header of every request. */
export const VERSION = '1.2.0';

const MEDIA = ['images', 'documents', 'videos'];
const MB = 1024 * 1024;
export const LARGE_FILE_THRESHOLD = 40 * MB;
const EMBED_MAX_BYTES = 50 * MB;
const DETECT_MAX_BYTES = 192 * MB;
const SYNC_DETECT_MAX_BYTES = 95 * MB;
/** Most files in one batch. */
export const MAX_BATCH_ITEMS = 100;
const ZIP_BATCH_MAX_BYTES = 55 * MB;
/** Slowest uplink an upload is given time for (about 1 Mbps), on top of the client timeout. */
export const UPLOAD_MIN_BYTES_PER_SECOND = 128 * 1024;
/** Largest batch archive the SDK accepts: 1 GiB of results plus 64 MiB for the zip itself. */
export const ARCHIVE_MAX_BYTES = 1024 * MB + 64 * MB;
const UPLOAD_CHUNK_BYTES = 64 * 1024;
const FINAL_BATCH = ['completed', 'failed', 'cancelled', 'expired'];
const UPLOAD_KINDS = { images: 'image', documents: 'document', videos: 'video' };
const FILENAMES = { images: 'image.png', documents: 'document.pdf', videos: 'video.mp4' };
const DURABLE = ['watermarks/images', 'watermarks/documents', 'watermarks/videos', 'watermarks/videos/detect'];
const IDS = {
  request: [/^req_[a-f0-9]{64}$/, 'request ID'], asset: [/^ast_[a-f0-9]{64}$/, 'asset ID'],
  webhook: [/^wh_[a-f0-9]{32}$/, 'webhook ID'], event: [/^evt_[a-f0-9]{64}$/, 'webhook event ID'],
  destination: [/^dst_[a-f0-9]{32}$/, 'storage destination ID'], delivery: [/^std_[a-f0-9]{64}$/, 'storage delivery ID'],
  batch: [/^bat_[a-f0-9]{32}$/, 'batch ID'],
};
const ACCELERATORS = ['cpu', 'gpu'];
const SECRET_TEXT = /\b(?:etchv|whsec|sk_live|sk_test)_[A-Za-z0-9_+/=-]+/g;

function errorMessage(statusCode, detail) {
  const base = statusCode === 0 ? 'Etchv request timed out' : `Etchv request failed (HTTP ${statusCode})`;
  const text = typeof detail === 'string' ? detail
    : typeof detail?.detail === 'string' ? detail.detail
      : typeof detail?.detail?.message === 'string' ? detail.detail.message
        : typeof detail?.message === 'string' ? detail.message : '';
  // Never echo credentials or markup from an unexpected response into an error message.
  const safe = text.includes('<') ? '' : text.replace(SECRET_TEXT, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 200);
  return safe ? `${base}: ${safe}` : base;
}

/**
 * HTTP or protocol failure returned by the Etchv API. Subclasses identify common
 * statuses; all of them carry the HTTP `statusCode`, parsed `detail` and the
 * `X-Request-ID` (`requestId`) to quote when contacting support. `code` is the
 * API's machine-readable error code (such as `rate_limited`) when it sends one,
 * and `retryAfter` the `Retry-After` delay in seconds.
 */
export class EtchvError extends Error {
  constructor(statusCode, detail, requestId = null, retryAfter = null) {
    super(errorMessage(statusCode, detail));
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.detail = detail;
    this.requestId = requestId;
    this.code = typeof detail?.detail?.code === 'string' ? detail.detail.code : null;
    this.limit = Number.isFinite(detail?.detail?.limit) ? detail.detail.limit : null;
    this.retryAfter = retryAfter;
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
/**
 * `submitBatch` failed after the batch was created: an upload (or the start) could not
 * complete. `batchId` and `idempotencyKey` are always set: call `submitBatch` again with
 * that `idempotencyKey` and the same items to upload what is missing and start. `statusCode`
 * is the HTTP status, or 0 for a network error, timeout or unreadable file (see `cause`).
 */
export class BatchSubmitError extends EtchvError {
  constructor(statusCode, detail, requestId = null, retryAfter = null) {
    super(statusCode, detail, requestId, retryAfter);
    const inner = detail?.detail ?? {};
    if (typeof inner.message === 'string') this.message = `Etchv batch submission failed: ${inner.message}`;
    this.batchId = inner.batch_id ?? null;
    this.idempotencyKey = inner.idempotency_key ?? null;
    this.index = inner.index ?? null;
    this.filename = inner.filename ?? null;
  }
}

// An abort through `signal` after the batch exists: keep the reason's name (usually
// 'AbortError') so abort checks still work, and attach what is needed to resume.
function abortError(reason, batchId, key) {
  const error = submitError(reason, batchId, key, 'batch_aborted', 'Submitting the batch was aborted');
  error.name = typeof reason?.name === 'string' ? reason.name : 'AbortError';
  return error;
}

function submitError(error, batchId, key, code, what, index, filename) {
  const statusCode = error instanceof EtchvError ? error.statusCode : 0;
  const reason = statusCode ? `HTTP ${statusCode}` : (error?.code || error?.name || 'error');
  const detail = { code, batch_id: batchId, idempotency_key: key,
    message: `${what} (${reason}); call submitBatch again with idempotencyKey '${key}' and the same items to resume` };
  if (index !== undefined) Object.assign(detail, { index, filename });
  const wrapped = new BatchSubmitError(statusCode, { detail }, error?.requestId ?? null, error?.retryAfter ?? null);
  wrapped.cause = error;
  return wrapped;
}

const ERRORS = {
  401: AuthenticationError, 402: PaymentRequiredError, 403: PermissionDeniedError, 404: NotFoundError,
  409: ConflictError, 410: GoneError, 413: InvalidRequestError, 422: InvalidRequestError, 429: RateLimitError,
};
function errorFor(statusCode, detail, requestId, retryAfter = null) {
  const Type = ERRORS[statusCode] || (statusCode >= 500 ? ServiceUnavailableError : EtchvError);
  return new Type(statusCode, detail, requestId, retryAfter);
}

// Retry-After as seconds (delta-seconds or HTTP date), or null when absent or invalid.
function retryAfterSeconds(value) {
  if (!value) return null;
  const seconds = /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : (Date.parse(value) - Date.now()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, seconds) : null;
}
// Wait before retrying: Retry-After clamped to 0.01–5 s, or 1 s without one.
const retryDelay = response => Math.min(5, Math.max(0.01, retryAfterSeconds(response.headers.get('retry-after')) ?? 1));

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

const archiveTooLarge = requestId => new EtchvError(200, { detail: { code: 'archive_too_large',
  message: `The archive is larger than ${ARCHIVE_MAX_BYTES / MB} MiB; download each item's result instead` } }, requestId);

function concatBytes(a, b) {
  const joined = new Uint8Array(a.byteLength + b.byteLength);
  joined.set(a); joined.set(b, a.byteLength);
  return joined;
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
  signal?.addEventListener('abort', onAbort, { once: true });
});

function batchKey(key) {
  if (key === undefined) return globalThis.crypto.randomUUID();
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(key)) {
    throw new TypeError('idempotencyKey must contain 8–128 letters, digits, hyphens or underscores');
  }
  return key;
}

function checkBatchCount(items) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array of batch items');
  if (items.length < 1 || items.length > MAX_BATCH_ITEMS) {
    throw new RangeError(`A batch takes 1 to ${MAX_BATCH_ITEMS} files; got ${items.length}. Split larger sets into several batches.`);
  }
}

function batchData(data, filename) {
  try { encodeData(data); } catch (error) { throw new TypeError(`${filename}: ${error.message}`); }
  return data;
}

async function batchFiles(items) {
  checkBatchCount(items);
  return Promise.all(items.map(async (item) => {
    if (!item || typeof item.filename !== 'string' || !item.filename) throw new TypeError('Each batch item needs a filename, a file and data');
    const { filename, file } = item;
    let size;
    if (file instanceof Uint8Array) size = file.byteLength;
    else if (typeof file === 'string' && file) size = (await stat(file)).size;
    else throw new TypeError(`${filename}: file must be a Buffer, Uint8Array or file path`);
    if (size < 1) throw new TypeError(`${filename}: file is empty`);
    return { filename, file, size, data: batchData(item.data, filename) };
  }));
}

function batchOptions({ archive, webhookId, accelerator, storageDestinationId }) {
  if (typeof archive !== 'boolean') throw new TypeError('archive must be a boolean');
  const options = { archive };
  if (webhookId != null) options.webhook_id = checkId('webhook', webhookId);
  if (accelerator != null) {
    if (!ACCELERATORS.includes(accelerator)) throw new TypeError("accelerator must be 'cpu' or 'gpu'");
    options.accelerator = accelerator;
  }
  if (storageDestinationId != null) {
    if (archive) throw new TypeError('archive and storageDestinationId cannot be combined');
    options.storage_destination_id = checkId('destination', storageDestinationId);
  }
  return options;
}

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
  #largeFileThreshold;
  /**
   * @param {object} options
   * @param {string} options.apiKey Organization API key.
   * @param {string} [options.baseUrl] API origin (default `https://api.etchv.com`). HTTPS only, except localhost.
   * @param {number} [options.timeout] Per-call deadline in milliseconds (default 120000).
   * @param {typeof fetch} [options.fetch] Custom fetch implementation, e.g. for tests.
   * @param {number} [options.largeFileThreshold] Files above this many bytes go through an upload session (default 40 MB).
   */
  constructor({ apiKey, baseUrl = 'https://api.etchv.com', timeout = 120000, fetch: fetchImpl = globalThis.fetch,
    largeFileThreshold = LARGE_FILE_THRESHOLD } = {}) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('apiKey is required');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new TypeError('baseUrl must use HTTPS (HTTP is allowed for localhost)');
    }
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
    if (!Number.isSafeInteger(largeFileThreshold) || largeFileThreshold < 1) throw new TypeError('largeFileThreshold must be a positive integer');
    this.#largeFileThreshold = largeFileThreshold;
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '') + '/';
    this.#timeout = timeout;
    this.#fetch = fetchImpl;
    this.#userAgent = `etchv-node/${VERSION}` + (globalThis.process?.version ? ` node/${globalThis.process.version}` : '');
  }

  #headers(extra = {}) {
    return { 'X-API-Key': this.#apiKey, 'User-Agent': this.#userAgent, ...extra };
  }

  async #post(path, file, { filename = 'image.png', idempotencyKey, storageDestinationId, storageKey, accelerator, signal, timeout } = {}, data) {
    const detect = path.split('?')[0].includes('/detect');
    const limit = detect ? DETECT_MAX_BYTES : EMBED_MAX_BYTES;
    if (!(file instanceof Uint8Array) || !file.byteLength || file.byteLength > limit) {
      throw new TypeError(`file must be a Buffer or Uint8Array containing 1 byte to ${limit / MB} MB`);
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
    if (accelerator != null) {
      if (!ACCELERATORS.includes(accelerator)) throw new TypeError("accelerator must be 'cpu' or 'gpu'");
      path += (path.includes('?') ? '&' : '?') + new URLSearchParams({ accelerator });
    }
    const form = new FormData();
    if (file.byteLength > this.#largeFileThreshold) {
      // Too large for one request body: upload once; every retry sends the same upload_id.
      const kind = detect ? 'detect' : UPLOAD_KINDS[path.split('/')[1]];
      const upload = await this.uploadFile(kind, file, { filename, signal, timeout });
      form.append('upload_id', upload.upload_id);
    } else {
      form.append('file', new Blob([file], { type: 'application/octet-stream' }), filename);
    }
    if (data !== undefined) form.append('data', data);
    const route = path.split('?')[0];
    const accepted = route.endsWith('/async');
    const durable = accepted || DURABLE.includes(route);
    const headers = this.#headers();
    const key = idempotencyKey ?? (durable ? globalThis.crypto.randomUUID() : undefined);
    if (key !== undefined) headers['Idempotency-Key'] = key;
    return this.#request(path, { method: 'POST', headers, body: form }, { durable, accepted, idempotencyKey: key, signal, timeout });
  }

  async #request(path, init, { durable = false, accepted = false, retry = [429, 502, 503, 504], idempotencyKey, signal, timeout = this.#timeout } = {}) {
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
        await pause(retryDelay(response));
        continue;
      }
      if (durable && retry.includes(response.status) && detail?.status !== 'failed') {
        // Honor Retry-After (capped at 5 s); pause() never waits past the deadline.
        await pause(response.status === 429 ? retryDelay(response) : 1);
        continue;
      }
      throw errorFor(response.status, detail, requestId, retryAfterSeconds(response.headers.get('retry-after')));
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

  // Upload sessions

  /**
   * Upload a file once to a signed URL and return its session (`upload_id`, `status`).
   * `kind` is `image`, `document`, `video` or `detect`. Embed and detect methods do this
   * automatically above `largeFileThreshold`.
   */
  async uploadFile(kind, file, { filename = 'file', signal, timeout = this.#timeout } = {}) {
    if (!['image', 'document', 'video', 'detect'].includes(kind)) throw new TypeError("kind must be 'image', 'document', 'video' or 'detect'");
    if (!(file instanceof Uint8Array) || !file.byteLength) throw new TypeError('file must be a Buffer or Uint8Array with at least 1 byte');
    const session = await this.#json('uploads', { method: 'POST', body: { kind, filename, size: file.byteLength }, signal, timeout });
    const upload = session?.upload;
    if (!upload || upload.method !== 'PUT' || !String(upload.url).startsWith('https://')) {
      throw new EtchvError(201, 'Invalid upload session response', null);
    }
    await this.#put(upload.url, file, { signal, timeout });
    const { upload: _, ...rest } = session;
    return { ...rest, status: 'received' };
  }

  // A PUT is aborted only when no bytes move (and no response arrives) for `timeout`: the
  // body is streamed in chunks and each chunk taken by the connection resets the watchdog,
  // so slow but steady uploads finish. Retries stop after `timeout` plus the time the file
  // needs at UPLOAD_MIN_BYTES_PER_SECOND.
  async #put(url, file, { signal, timeout = this.#timeout }) {
    const deadline = Date.now() + timeout + Math.ceil(file.byteLength * 1000 / UPLOAD_MIN_BYTES_PER_SECOND);
    while (true) {
      signal?.throwIfAborted(); // A listener never fires for a signal that is already aborted.
      let response;
      const controller = new AbortController();
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException('No upload progress within the client timeout', 'TimeoutError')), timeout);
      };
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) controller.abort(signal.reason);
      let offset = 0;
      const body = new ReadableStream({
        pull(stream) {
          arm();
          if (offset >= file.byteLength) return stream.close();
          const end = Math.min(offset + UPLOAD_CHUNK_BYTES, file.byteLength);
          stream.enqueue(file.slice(offset, end));
          offset = end;
        },
      }, { highWaterMark: 0 });
      arm();
      try {
        // The signed URL carries its own authorization: never send the API key there.
        response = await this.#fetch(url, {
          method: 'PUT', body, duplex: 'half', redirect: 'manual', signal: controller.signal,
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.byteLength), 'User-Agent': this.#userAgent },
        });
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (Date.now() >= deadline) throw new EtchvTimeoutError(0, { message: 'Client deadline exceeded' }, null);
        await sleep(1000, signal);
        continue;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
      if (response.status === 200) return;
      if ([500, 502, 503, 504].includes(response.status) && Date.now() < deadline) {
        await sleep(1000, signal);
        continue;
      }
      throw errorFor(response.status, (await response.text()).slice(0, 1000) || 'Upload refused', null);
    }
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

  // Batches

  /**
   * Watermark up to 100 files as one batch and resolve with it once started: creates the
   * batch, uploads every file to its signed URL (`uploadConcurrency` at a time, never with
   * the API key), then starts it. `file` is a Buffer/Uint8Array or a file path. Transient
   * failures are retried with the same `idempotencyKey` (generated when omitted). If an
   * upload or the start fails for good, `BatchSubmitError` carries `batchId` and
   * `idempotencyKey`: call again with that key and the same items to upload the rest and
   * start. Resuming a batch that was not started within 24 hours rejects with `GoneError`
   * (`code` `batch_expired`).
   */
  async submitBatch(items, { archive = false, webhookId, accelerator, storageDestinationId, idempotencyKey,
    uploadConcurrency = 4, signal, timeout } = {}) {
    const files = await batchFiles(items);
    if (!Number.isSafeInteger(uploadConcurrency) || uploadConcurrency < 1 || uploadConcurrency > 16) {
      throw new TypeError('uploadConcurrency must be an integer from 1 to 16');
    }
    const key = batchKey(idempotencyKey);
    const body = { items: files.map(({ filename, size, data }) => ({ filename, size, data })),
      ...batchOptions({ archive, webhookId, accelerator, storageDestinationId }) };
    // 503 means batch uploads are unavailable: reject at once (submitBatchZip still works).
    const { batch } = await this.#batchRequest('watermarks/batches', {
      method: 'POST', body: encodeJson(body), key, retry: [429, 502, 504], signal, timeout });
    if (batch.status === 'expired') {
      throw new GoneError(410, { detail: { code: 'batch_expired', batch_id: batch.batch_id, idempotency_key: key,
        message: 'This batch was not started within 24 hours and expired; submit the files again with a new idempotencyKey' } }, null);
    }
    if (batch.status !== 'draft') return batch; // A replay of a batch that already started (or was canceled).
    const uploads = [];
    for (const item of batch.items ?? []) {
      if (item?.upload == null || item.upload_received === true) continue; // Already uploaded (a resumed batch).
      if (!Number.isSafeInteger(item.index) || !files[item.index] || item.upload.method !== 'PUT' ||
        !String(item.upload.url).startsWith('https://')) throw new EtchvError(201, 'Invalid batch upload response', null);
      uploads.push([item.index, item.upload.url]);
    }
    await this.#uploadBatch(batch.batch_id, key, files, uploads, uploadConcurrency, { signal, timeout });
    try {
      return (await this.#batchRequest(`watermarks/batches/${batch.batch_id}/start`, { method: 'POST', accepted: true, signal, timeout })).batch;
    } catch (error) {
      // Definitive refusals (for example 410 when the draft expired) and aborts pass through.
      if (signal?.aborted) throw abortError(signal.reason, batch.batch_id, key);
      if (error instanceof EtchvError && error.statusCode >= 400 && error.statusCode < 500) throw error;
      throw submitError(error, batch.batch_id, key, 'batch_start_failed', 'Starting the batch failed');
    }
  }

  async #uploadBatch(batchId, key, files, uploads, concurrency, { signal, timeout = this.#timeout }) {
    let next = 0;
    let failure = null;
    const worker = async () => {
      while (next < uploads.length && !failure) {
        if (signal?.aborted) {
          failure ??= abortError(signal.reason, batchId, key);
          break;
        }
        const [index, url] = uploads[next++];
        const { filename, file, size } = files[index];
        try {
          const bytes = typeof file === 'string' ? await readFile(file) : file;
          signal?.throwIfAborted();
          if (bytes.byteLength !== size) throw new TypeError(`${filename} changed size after the batch was created`);
          await this.#put(url, bytes, { signal, timeout });
        } catch (error) {
          failure ??= signal?.aborted ? abortError(signal.reason, batchId, key)
            : submitError(error, batchId, key, 'batch_upload_failed', `Uploading ${filename} (item ${index}) failed`, index, filename);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, uploads.length) }, worker));
    if (failure) throw failure;
  }

  /**
   * Create and start a batch from one zip (up to 55 MB) of files already together. `items`
   * lists every member as `{ filename: <exact member path>, data }`. Retried like `submitBatch`.
   */
  async submitBatchZip(zip, items, { archive = false, webhookId, accelerator, storageDestinationId, idempotencyKey, signal, timeout } = {}) {
    const bytes = typeof zip === 'string' ? await readFile(zip) : zip;
    if (!(bytes instanceof Uint8Array) || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes.byteLength > ZIP_BATCH_MAX_BYTES) {
      throw new TypeError(`zip must be a zip of up to ${ZIP_BATCH_MAX_BYTES / MB} MB (bytes or a file path)`);
    }
    checkBatchCount(items);
    const members = items.map((item) => {
      if (!item || typeof item.filename !== 'string' || !item.filename) throw new TypeError('Each zip item needs a filename (the member path in the zip) and data');
      return { filename: item.filename, data: batchData(item.data, item.filename) };
    });
    const form = new FormData();
    form.append('archive', new Blob([bytes], { type: 'application/zip' }), 'batch.zip');
    form.append('manifest', encodeJson({ items: members, ...batchOptions({ archive, webhookId, accelerator, storageDestinationId }) }));
    return (await this.#batchRequest('watermarks/batches/zip', {
      method: 'POST', form, key: batchKey(idempotencyKey), accepted: true, signal, timeout })).batch;
  }

  async #batchRequest(path, { method = 'GET', body, form, key, accepted = false, retry, signal, timeout } = {}) {
    const headers = this.#headers(body === undefined ? {} : { 'Content-Type': 'application/json' });
    if (key !== undefined) headers['Idempotency-Key'] = key;
    const response = await this.#request(path, { method, headers, ...((body ?? form) !== undefined ? { body: body ?? form } : {}) },
      { durable: true, accepted, idempotencyKey: key, signal, timeout, ...(retry ? { retry } : {}) });
    let batch;
    try { batch = await response.json(); } catch { batch = null; }
    if (!batch || !IDS.batch[0].test(batch.batch_id) || typeof batch.status !== 'string' ||
      (batch.items !== undefined && !Array.isArray(batch.items))) {
      throw new EtchvError(response.status, 'Invalid batch response', response.headers.get('x-request-id'));
    }
    return { batch, retryAfter: retryAfterSeconds(response.headers.get('retry-after')) };
  }

  /** Read a batch with every item's status (one request; see `waitForBatch` to poll). */
  async getBatch(batchId, options = {}) {
    return (await this.#batchRequest(`watermarks/batches/${checkId('batch', batchId)}`, callOptions(options))).batch;
  }

  /**
   * Poll a batch until it is final (`completed`, `failed`, `cancelled` or `expired`) and
   * resolve with it. Waits as long as the API's `Retry-After` asks between polls (or
   * `pollInterval` ms, whichever is longer). `timeout` bounds the whole wait (default one
   * hour); then it rejects with `EtchvTimeoutError` and the batch keeps running.
   */
  async waitForBatch(batchId, { timeout = 3_600_000, pollInterval, signal } = {}) {
    checkId('batch', batchId);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    if (pollInterval != null && (!Number.isFinite(pollInterval) || pollInterval <= 0)) throw new TypeError('pollInterval must be a positive number of milliseconds');
    const deadline = Date.now() + timeout;
    while (true) {
      const { batch, retryAfter } = await this.#batchRequest(`watermarks/batches/${batchId}`, { signal });
      if (FINAL_BATCH.includes(batch.status)) return batch;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new EtchvTimeoutError(0, { message: 'Client deadline exceeded; the batch is still running', batchId, status: batch.status }, null);
      }
      const delay = retryAfter != null ? Math.max(1, retryAfter) * 1000 : (pollInterval ?? 2000);
      await sleep(Math.min(Math.max(delay, pollInterval ?? 0), remaining), signal);
    }
  }

  /**
   * Wait for a batch to finish, then yield one result per item in order. Succeeded items
   * carry the verified file in `result` (downloaded as you iterate; results are kept 24
   * hours); others carry `errorCode` and were refunded or never charged.
   */
  async *iterBatchResults(batchId, options = {}) {
    const batch = await this.waitForBatch(batchId, options);
    for (const item of batch.items ?? []) {
      const base = { index: item.index, filename: item.filename, status: item.status, requestId: item.request_id ?? null };
      if (item.status === 'succeeded' && item.request_id) {
        yield { ...base, ok: true, result: await this.getEmbedResult(item.request_id, { signal: options.signal }), errorCode: null, errorDetail: null };
      } else {
        const errorCode = item.error_code ?? (['cancelled', 'expired'].includes(batch.status) ? batch.status : item.status);
        yield { ...base, ok: false, result: null, errorCode, errorDetail: item.error_detail ?? null };
      }
    }
  }

  /**
   * Wait for and download the zip of a batch created with `archive: true`: every successful
   * result plus `manifest.json`. It can reach 1 GB; `downloadBatchArchiveTo` streams it to a
   * file instead of memory. `timeout` bounds the wait for the archive (default one hour); the
   * download itself only fails if no data arrives for the client timeout. Rejects with
   * `ConflictError` (`code` `archive_not_requested`, `batch_not_started`, `archive_too_large`
   * or `archive_unavailable`) or `GoneError` after 24 hours or for an expired draft, and with
   * `EtchvError` (`code` `archive_too_large`, not retried) above `ARCHIVE_MAX_BYTES`.
   */
  async downloadBatchArchive(batchId, options = {}) {
    const opened = await this.#openArchive(batchId, options);
    const length = Number(opened.response.headers.get('content-length'));
    let buffer = Number.isSafeInteger(length) && length > 0 ? new Uint8Array(length) : null;
    const chunks = [];
    let size = 0;
    await this.#readArchive(opened, (chunk) => {
      if (buffer && size + chunk.byteLength <= buffer.byteLength) {
        buffer.set(chunk, size); // One allocation when the length is known.
      } else {
        if (buffer) { chunks.push(buffer.subarray(0, size)); buffer = null; }
        chunks.push(chunk);
      }
      size += chunk.byteLength;
    });
    if (buffer) return size === buffer.byteLength ? buffer : buffer.slice(0, size);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  /**
   * Like `downloadBatchArchive`, but streams the zip to a file path or a Node.js writable
   * stream (which is not ended) and resolves with the number of bytes written. A path is
   * written through a `.part` file that replaces it only once the download is complete.
   */
  async downloadBatchArchiveTo(batchId, destination, options = {}) {
    if (typeof destination !== 'string' && typeof destination?.write !== 'function') {
      throw new TypeError('destination must be a file path or a writable stream');
    }
    if (typeof destination !== 'string') {
      const opened = await this.#openArchive(batchId, options);
      return this.#readArchive(opened, async (chunk) => {
        if (!destination.write(chunk)) await once(destination, 'drain');
      });
    }
    const partial = `${destination}.part`;
    // Open the file first so a bad path fails before any waiting.
    let handle = await open(partial, 'w');
    let opened;
    try {
      opened = await this.#openArchive(batchId, options);
      const size = await this.#readArchive(opened, async (chunk) => { await handle.write(chunk); });
      await handle.close();
      handle = null;
      await rename(partial, destination);
      return size;
    } catch (error) {
      opened?.controller.abort();
      opened?.release();
      await handle?.close().catch(() => {});
      await rm(partial, { force: true });
      throw error;
    }
  }

  // Wait until the archive is ready (202 while the batch runs) and return the open 200 response.
  async #openArchive(batchId, { timeout = 3_600_000, signal } = {}) {
    checkId('batch', batchId);
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    if (signal != null && !(signal instanceof AbortSignal)) throw new TypeError('signal must be an AbortSignal');
    const deadline = Date.now() + timeout;
    const url = new URL(`watermarks/batches/${batchId}/archive`, this.#baseUrl);
    while (true) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
      // The client timeout applies until the headers arrive, then again to each chunk.
      let timer;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException('No data within the client timeout', 'TimeoutError')), this.#timeout);
      };
      const release = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      arm();
      let response;
      try {
        response = await this.#fetch(url, { method: 'GET', headers: this.#headers(), redirect: 'manual', signal: controller.signal });
      } catch (error) {
        release();
        if (signal?.aborted) throw signal.reason;
        if (Date.now() >= deadline) throw new EtchvTimeoutError(0, { message: 'Client deadline exceeded; the archive is not ready yet', batchId }, null);
        await sleep(1000, signal);
        continue;
      }
      const requestId = response.headers.get('x-request-id');
      const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
      if (response.status === 200) {
        if (Number(response.headers.get('content-length')) > ARCHIVE_MAX_BYTES) {
          controller.abort();
          release();
          throw archiveTooLarge(requestId);
        }
        const disarm = () => clearTimeout(timer);
        return { response, controller, requestId, arm, disarm, release, batchId };
      }
      let detail = '';
      try { detail = (await response.text()).slice(0, 10000); } catch { /* Keep the status. */ } finally { release(); }
      let delay;
      if (response.status === 202) delay = Math.max(1, retryAfter ?? 2);
      else if ([429, 502, 503, 504].includes(response.status)) delay = Math.max(1, Math.min(5, retryAfter ?? 1));
      else {
        try { detail = JSON.parse(detail); } catch { /* Preserve error text. */ }
        throw errorFor(response.status, detail, requestId, retryAfter);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new EtchvTimeoutError(0, { message: 'Client deadline exceeded; the archive is not ready yet', batchId }, requestId);
      await sleep(Math.min(delay * 1000, remaining), signal);
    }
  }

  // Stream the body to `write`, checking the zip signature; each chunk resets the idle timer.
  async #readArchive({ response, controller, requestId, arm, disarm, release, batchId }, write) {
    const invalid = () => new EtchvError(200, 'Invalid archive response', requestId);
    const reader = response.body?.getReader();
    let size = 0;
    let head = null;
    try {
      if (!reader) throw invalid();
      while (true) {
        arm();
        const { done, value } = await reader.read();
        if (done) break;
        let chunk = value;
        if (head !== false) {
          head = head ? concatBytes(head, value) : value;
          if (head.byteLength < 2) continue;
          if (head[0] !== 0x50 || head[1] !== 0x4b) throw invalid();
          chunk = head;
          head = false;
        }
        if (size + chunk.byteLength > ARCHIVE_MAX_BYTES) throw archiveTooLarge(requestId);
        disarm(); // Time spent writing (for example waiting for 'drain') is not network idle time.
        await write(chunk);
        size += chunk.byteLength;
      }
      if (!size) throw invalid();
      return size;
    } catch (error) {
      controller.abort();
      if (error?.name === 'TimeoutError') {
        throw new EtchvTimeoutError(0, { message: 'The archive download stalled', batchId }, requestId);
      }
      throw error;
    } finally {
      release();
    }
  }

  /**
   * Cancel a batch. A draft is canceled at once. In a started batch, files still waiting fail
   * with error code `cancelled` and are refunded; queued and running files finish, and the
   * batch then ends as `cancelled`.
   */
  async cancelBatch(batchId, options = {}) {
    return (await this.#batchRequest(`watermarks/batches/${checkId('batch', batchId)}/cancel`, { method: 'POST', ...callOptions(options) })).batch;
  }

  /** List batches newest first (`limit` 1–50), without items. Pass `before: page.next_cursor` for the next page. */
  async listBatches({ limit = 20, before, ...options } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new TypeError('limit must be an integer from 1 to 50');
    const params = new URLSearchParams({ limit: String(limit) });
    if (before != null) params.set('before', checkId('batch', before));
    const response = await this.#request(`watermarks/batches?${params}`, { method: 'GET', headers: this.#headers() },
      { durable: true, ...callOptions(options) });
    let page;
    try { page = await response.json(); } catch { page = null; }
    if (!page || !Array.isArray(page.data)) throw new EtchvError(response.status, 'Invalid batch list response', response.headers.get('x-request-id'));
    return page;
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
    return { image: result, watermarkId, requestId, contentType, filename, assetId: response.headers.get('x-asset-id'), sourceAssetId: response.headers.get('x-source-asset-id'), storageDeliveryId: response.headers.get('x-storage-delivery-id'), accelerator: acceleratorUsed(response.headers.get('x-etchv-accelerator')) };
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
    if (media !== 'videos' && file instanceof Uint8Array && file.byteLength > SYNC_DETECT_MAX_BYTES) {
      // Synchronous image and PDF detection stops at 95 MB; larger delivered files run as a job.
      const receipt = await this.submitDetection(media, file, options);
      return this.getDetectionResult(receipt.request_id, callOptions(options));
    }
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
    const accelerator = acceleratorUsed(response.headers.get('x-etchv-accelerator')) ?? acceleratorUsed(result.accelerator);
    return { watermarked: result.watermarked, confidence: result.confidence, watermarkId: result.watermark_id, requestId, units, accelerator };
  }
}

// The processor that actually ran ('cpu' or 'gpu'), or null when absent or unrecognized.
const acceleratorUsed = value => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ACCELERATORS.includes(normalized) ? normalized : null;
};
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
