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
    const durable = path.split("?")[0].endsWith("/async") || ['watermarks/images', 'watermarks/documents', 'watermarks/videos', 'watermarks/videos/detect'].includes(path);
    if (durable && !headers['Idempotency-Key']) headers['Idempotency-Key'] = globalThis.crypto.randomUUID();
    return this.#request(path, { method: 'POST', headers, body: form }, durable, headers['Idempotency-Key']);
  }
  async #request(path, init, durable, idempotencyKey) {
    const asyncSubmission = path.split("?")[0].endsWith("/async");
    const detectionJob = path === "watermarks/videos/detect" || path.includes("detection-jobs/");
    const deadline = Date.now() + this.#timeout;
    let requestId = path.match(/watermarks\/jobs\/(req_[a-f0-9]{64})/)?.[1] || null;
    const pause = async (seconds = 1) => {
      await new Promise(resolve => setTimeout(resolve, Math.min(seconds * 1000, Math.max(0, deadline - Date.now()))));
    };
    while (Date.now() < deadline) {
      let response;
      let body;
      try {
        response = await this.#fetch(new URL(path, this.#baseUrl), {
          ...init, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        requestId = response.headers.get('x-request-id') || requestId;
        body = await response.arrayBuffer();
      } catch (error) {
        if (!durable) throw error;
        await pause();
        continue;
      }
      requestId = response.headers.get('x-request-id') || requestId;
      if ([200,201,204].includes(response.status) || (asyncSubmission && response.status === 202)) return new Response(response.status === 204 ? null : body, { status: response.status, headers: response.headers });
      let detail = new TextDecoder().decode(body).slice(0, 10000);
      try { detail = JSON.parse(detail); } catch { /* Preserve error text. */ }
      if (durable && response.status === 202) {
        if (!detail || typeof detail !== 'object' || !/^req_[a-f0-9]{64}$/.test(detail.request_id)) {
          throw new EtchvError(202, 'Invalid job response', requestId);
        }
        requestId = detail.request_id;
        // Construct a trusted local path; never send API keys to a server-supplied URL.
        path = `watermarks/${detectionJob ? "detection-jobs" : "jobs"}/${requestId}/result`;
        init = { method: 'GET', headers: { 'X-API-Key': this.#apiKey } };
        const wait = Number(response.headers.get('retry-after') || 1);
        await pause(Number.isFinite(wait) ? Math.min(5, Math.max(0.01, wait)) : 1);
        continue;
      }
      if (durable && [429,502,503,504].includes(response.status) && detail?.status !== 'failed') {
        await pause();
        continue;
      }
      throw new EtchvError(response.status, detail, requestId);
    }
    throw new EtchvError(0, { message: 'Client deadline exceeded; the job may still complete', idempotencyKey }, requestId);
  }
  #asyncPath(media, detect, webhookId) {
    if (!['images','documents','videos'].includes(media)) throw new TypeError('media must be images, documents or videos');
    if (webhookId != null && !/^wh_[a-f0-9]{32}$/.test(webhookId)) throw new TypeError('Invalid webhook ID');
    return `watermarks/${media}${detect ? '/detect' : ''}/async${webhookId ? '?webhook_id=' + webhookId : ''}`;
  }
  async submitEmbed(media, file, data, {webhookId, ...options} = {}) {
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || !Object.keys(data).length) throw new TypeError('data must be a non-empty JSON object');
    const body = JSON.stringify(data, (_key, value) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('data must contain JSON values');
      return value;
    });
    return (await this.#post(this.#asyncPath(media, false, webhookId), file, options, body)).json();
  }
  async submitDetection(media, file, {webhookId, ...options} = {}) {
    return (await this.#post(this.#asyncPath(media, true, webhookId), file, options)).json();
  }
  async getJob(requestId, {detect = false} = {}) {
    if (!/^req_[a-f0-9]{64}$/.test(requestId)) throw new TypeError('Invalid request ID');
    return (await this.#assetRequest(`watermarks/${detect ? 'detection-jobs' : 'jobs'}/${requestId}`)).json();
  }
  #assetPath(id) {
    if (typeof id !== 'string' || !/^ast_[a-f0-9]{64}$/.test(id)) throw new TypeError('Invalid asset ID');
    return `assets/${id}`;
  }
  async #assetRequest(path, method = 'GET', body) {
    return this.#request(path, {method, headers: {'X-API-Key': this.#apiKey, ...(body === undefined ? {} : {'Content-Type':'application/json'})}, ...(body === undefined ? {} : {body:JSON.stringify(body, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Metadata numbers must be finite'); return value; })})}, false);
  }
  async listAssets({limit = 25, cursor, kind, mediaType, watermarkId} = {}) {
    const params = new URLSearchParams({limit:String(limit)});
    for (const [key,value] of Object.entries({cursor,kind,media_type:mediaType,watermark_id:watermarkId})) if (value != null) params.set(key,value);
    return (await this.#assetRequest(`assets?${params}`)).json();
  }
  async getAsset(id) { return (await this.#assetRequest(this.#assetPath(id))).json(); }
  async updateAsset(id, changes) { return (await this.#assetRequest(this.#assetPath(id), 'PATCH', changes)).json(); }
  async deleteAsset(id) { await this.#assetRequest(this.#assetPath(id), 'DELETE'); }
  async deleteAssets(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50) throw new TypeError('Provide 1–50 asset IDs');
    ids.forEach(id => this.#assetPath(id));
    await this.#assetRequest('assets/bulk-delete', 'POST', {asset_ids:ids});
  }
  async downloadAsset(id) { return new Uint8Array(await (await this.#assetRequest(this.#assetPath(id) + '/content')).arrayBuffer()); }
  async getEmbedResult(requestId) {
    if (!/^req_[a-f0-9]{64}$/.test(requestId)) throw new TypeError('Invalid request ID');
    return this.#embeddingResult(await this.#request(`watermarks/jobs/${requestId}/result`, {
      method: 'GET', headers: { 'X-API-Key': this.#apiKey },
    }, true));
  }
  async embedImage(image, data, options = {}) { return this.#embed('images', image, data, options); }
  async embedDocument(document, data, options = {}) { return this.#embed('documents', document, data, {filename:'document.pdf', ...options}); }
  async embedVideo(video, data, options = {}) { return this.#embed("videos", video, data, {filename:"video.mp4", ...options}); }
  async #embed(media, image, data, options) {
    if (!data || Object.getPrototypeOf(data) !== Object.prototype || !Object.keys(data).length) {
      throw new TypeError('data must be a non-empty JSON object');
    }
    const encoded = JSON.stringify(data, (_key, value) => {
      if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
          (typeof value === 'number' && !Number.isFinite(value))) throw new TypeError('data must contain JSON values');
      return value;
    });
    const response = await this.#post(`watermarks/${media}`, image, options, encoded);
    return this.#embeddingResult(response);
  }
  async #embeddingResult(response) {
    const watermarkId = response.headers.get('x-watermark-id');
    const requestId = response.headers.get('x-request-id');
    const result = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type')?.split(';')[0];
    const extension = imageExtension(result, contentType);
    if (!extension || !validId(watermarkId)) {
      throw new EtchvError(200, 'Invalid embedding response', requestId);
    }
    const filename = response.headers.get('content-disposition')?.match(/filename="([A-Za-z0-9._-]+)"/)?.[1] || `image-watermarked.${extension}`;
    return { image: result, watermarkId, requestId, contentType, filename, assetId: response.headers.get("x-asset-id"), sourceAssetId: response.headers.get("x-source-asset-id") };
  }
  async detectImage(image, options = {}) { return this.#detect('images', image, options); }
  async detectDocument(document, options = {}) { return this.#detect('documents', document, {filename:'document.pdf', ...options}); }
  async detectVideo(video, options = {}) { return this.#detect("videos", video, {filename:"video.mp4", ...options}); }
  async #detect(media, image, options) {
    const response = await this.#post(`watermarks/${media}/detect`, image, options);
    const requestId = response.headers.get('x-request-id');
    let result;
    try { result = await response.json(); } catch { throw new EtchvError(200, 'Invalid detection response', requestId); }
    if (!result || typeof result.watermarked !== 'boolean' || typeof result.confidence !== 'number' ||
        !Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1 ||
        (result.watermarked ? !validId(result.watermark_id) : result.watermark_id !== null)) {
      throw new EtchvError(200, 'Invalid detection response', requestId);
    }
    const rawUnits = result.units ?? [{index:0, ...result}];
    if (!Array.isArray(rawUnits) || !rawUnits.length || rawUnits.some((unit,index) =>
      !unit || unit.index !== index || typeof unit.watermarked !== 'boolean' ||
      typeof unit.confidence !== 'number' || !Number.isFinite(unit.confidence) || unit.confidence < 0 || unit.confidence > 1 ||
      (unit.watermarked ? !validId(unit.watermark_id) : unit.watermark_id !== null))) {
      throw new EtchvError(200, 'Invalid detection units', requestId);
    }
    const units = rawUnits.map(unit => ({index:unit.index, watermarked:unit.watermarked, confidence:unit.confidence, watermarkId:unit.watermark_id}));
    return { watermarked: result.watermarked, confidence: result.confidence, watermarkId: result.watermark_id, requestId, units };
  }
}

function imageExtension(bytes, mime) {
  const starts = (signature, offset = 0) => signature.every((byte, i) => bytes[offset + i] === byte);
  const ascii = (text, offset = 0) => starts(Array.from(text, c => c.charCodeAt(0)), offset);
  if ((mime === 'video/mp4' || mime === 'video/quicktime') && ascii('ftyp',4)) return mime === 'video/mp4' ? 'mp4' : 'mov';
  if (mime === 'application/pdf' && ascii('%PDF-')) return 'pdf';
  if (mime === 'image/png' && starts([137,80,78,71,13,10,26,10])) return 'png';
  if (mime === 'image/jpeg' && starts([255,216,255])) return 'jpg';
  if (mime === 'image/gif' && (ascii('GIF87a') || ascii('GIF89a'))) return 'gif';
  if (mime === 'image/tiff' && (starts([73,73,42,0]) || starts([77,77,0,42]))) return 'tiff';
  if (mime === 'image/bmp' && ascii('BM')) return 'bmp';
  if (mime === 'image/x-portable-pixmap' && (ascii('P6') || ascii('P3'))) return 'ppm';
  if (mime === 'image/webp' && ascii('RIFF') && ascii('WEBP', 8)) return 'webp';
  if (mime === 'image/vnd.adobe.photoshop' && ascii('8BPS') && bytes[4] === 0) return ({1:'psd',2:'psb'})[bytes[5]];
  return null;
}
