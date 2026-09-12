export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface RequestOptions { filename?: string; idempotencyKey?: string; storageDestinationId?: string; storageKey?: string }
export interface AsyncOptions extends RequestOptions { webhookId?: string }
export interface Job { storage_delivery_id?: string | null; storage_destination_id?: string | null; request_id: string; status: string; status_url: string; result_url: string; operation: 'embed' | 'detect'; webhook_id: string | null; error_code: string | null; asset_id: string | null; source_asset_id: string | null; format: string; frame_count: number; attempts: number; credits: number; result_expires_at: string | null }
export interface EmbedResult { image: Uint8Array; watermarkId: string; requestId: string | null; contentType: string; filename: string; assetId: string | null; sourceAssetId: string | null; storageDeliveryId: string | null }
export interface DetectionUnit { index: number; watermarked: boolean; confidence: number; watermarkId: string | null }
export interface DetectionResult { units: DetectionUnit[]; watermarked: boolean; confidence: number; watermarkId: string | null; requestId: string | null }
export declare class EtchvError extends Error {
  constructor(statusCode: number, detail: unknown, requestId?: string | null);
  statusCode: number;
  detail: unknown;
  requestId: string | null;
}
export interface Asset {
  id: string; name: string; kind: "source" | "watermarked"; media_type: "image" | "document" | "video";
  format: string; content_type: string; size_bytes: number; sha256: string; parent_asset_id: string | null;
  request_id: string; watermark_id: string | null; created_at: string; updated_at: string;
  file_expires_at: string; file_available: boolean; version: number; metadata: Record<string, JsonValue> | null; download_url: string | null;
}
export interface AssetPage { items: Asset[]; next_cursor: string | null }
export declare class Etchv {
  submitEmbed(media: 'images' | 'documents' | 'videos', file: Uint8Array, data: Record<string, JsonValue>, options?: AsyncOptions): Promise<Job>;
  submitDetection(media: 'images' | 'documents' | 'videos', file: Uint8Array, options?: AsyncOptions): Promise<Job>;
  getJob(requestId: string, options?: {detect?: boolean}): Promise<Job>;
  listAssets(options?: {limit?: number; cursor?: string; kind?: "source" | "watermarked"; mediaType?: "image" | "document" | "video"; watermarkId?: string}): Promise<AssetPage>;
  getAsset(id: string): Promise<Asset>;
  updateAsset(id: string, changes: {version: number; name?: string; metadata?: Record<string, JsonValue> | null}): Promise<Asset>;
  deleteAsset(id: string): Promise<void>;
  deleteAssets(ids: string[]): Promise<void>;
  downloadAsset(id: string): Promise<Uint8Array>;
  constructor(options: { apiKey: string; baseUrl?: string; timeout?: number; fetch?: typeof globalThis.fetch });
  getStorageDelivery(id: string): Promise<Record<string, JsonValue>>;
  embedImage(image: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  embedDocument(document: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  detectDocument(document: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  embedVideo(video: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  detectVideo(video: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  getEmbedResult(requestId: string): Promise<EmbedResult>;
  detectImage(image: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
}
