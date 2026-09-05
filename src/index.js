export class EtchvError extends Error {
  constructor(statusCode, detail, requestId = null) {
    super(`Etchv request failed (HTTP ${statusCode})`);
    this.name = 'EtchvError';
    this.statusCode = statusCode;
    this.detail = detail;
    this.requestId = requestId;
  }
}
const validId = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

export class Etchv {
  #apiKey;
  #baseUrl;
  #timeout;
  #fetch;
  constructor({ apiKey, baseUrl = 'https://api.etchv.com', timeout = 120000, fetch: fetchImpl = globalThis.fetch }) {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new TypeError('apiKey is required');
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw new TypeError('baseUrl must use HTTPS (HTTP is allowed for localhost)');
    }
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new TypeError('timeout must be a positive integer');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl.replace(/\/+$/, '') + '/';
    this.#timeout = timeout;
    this.#fetch = fetchImpl;
  }
  async #post(path, image, { filename = 'image.png', idempotencyKey } = {}, data) {
    if (!(image instanceof Uint8Array) || !image.byteLength || image.byteLength > 20 * 1024 * 1024) {
      throw new TypeError('image must be a Buffer or Uint8Array containing 1 byte to 20 MB');
    }
    const form = new FormData();
    form.append('file', new Blob([image], { type: 'application/octet-stream' }), filename);
    if (data !== undefined) form.append('data', data);
    const headers = { 'X-API-Key': this.#apiKey };
    if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
    const response = await this.#fetch(new URL(path, this.#baseUrl), {
      method: 'POST', headers, body: form, redirect: 'manual', signal: AbortSignal.timeout(this.#timeout),
    });
    if (response.status !== 200) {
      let detail = (await response.text()).slice(0, 10000);
      try { detail = JSON.parse(detail); } catch { /* Preserve non-JSON error text. */ }
      throw new EtchvError(response.status, detail, response.headers.get('x-request-id'));
    }
    return response;
  }
  async embedImage(image, data, options = {}) {
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || !Object.keys(data).length) {
      throw new TypeError('data must be a non-empty JSON object');
    }
    const encoded = JSON.stringify(data, (_key, value) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('data must contain JSON values');
      return value;
    });
    const response = await this.#post('watermarks/images', image, options, encoded);
    const watermarkId = response.headers.get('x-watermark-id');
    const requestId = response.headers.get('x-request-id');
    const result = new Uint8Array(await response.arrayBuffer());
    if (response.headers.get('content-type')?.split(';')[0] !== 'image/png' || !validId(watermarkId) ||
        ![137,80,78,71,13,10,26,10].every((byte, i) => result[i] === byte)) {
      throw new EtchvError(200, 'Invalid embedding response', requestId);
    }
    return { image: result, watermarkId, requestId };
  }
  async detectImage(image, options = {}) {
    const response = await this.#post('watermarks/images/detect', image, options);
    const requestId = response.headers.get('x-request-id');
    let result;
    try { result = await response.json(); } catch { throw new EtchvError(200, 'Invalid detection response', requestId); }
    if (!result || typeof result.watermarked !== 'boolean' || typeof result.confidence !== 'number' ||
        !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
        (result.watermarked ? !validId(result.watermark_id) : result.watermark_id !== null)) {
      throw new EtchvError(200, 'Invalid detection response', requestId);
    }
    return { watermarked: result.watermarked, confidence: result.confidence, watermarkId: result.watermark_id, requestId };
  }
}
