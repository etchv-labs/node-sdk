export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface RequestOptions { filename?: string; idempotencyKey?: string }
export interface EmbedResult { image: Uint8Array; watermarkId: string; requestId: string | null; contentType: string; filename: string }
export interface DetectionUnit { index: number; watermarked: boolean; confidence: number; watermarkId: string | null }
export interface DetectionResult { units: DetectionUnit[]; watermarked: boolean; confidence: number; watermarkId: string | null; requestId: string | null }
export declare class EtchvError extends Error {
  constructor(statusCode: number, detail: unknown, requestId?: string | null);
  statusCode: number;
  detail: unknown;
  requestId: string | null;
}
export declare class Etchv {
  constructor(options: { apiKey: string; baseUrl?: string; timeout?: number; fetch?: typeof globalThis.fetch });
  embedImage(image: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  embedDocument(document: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  detectDocument(document: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  embedVideo(video: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  detectVideo(video: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
  getEmbedResult(requestId: string): Promise<EmbedResult>;
  detectImage(image: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
}
