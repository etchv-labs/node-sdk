export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface RequestOptions { filename?: string; idempotencyKey?: string }
export interface EmbedResult { image: Uint8Array; watermarkId: string; requestId: string | null }
export interface DetectionResult { watermarked: boolean; confidence: number; watermarkId: string | null; requestId: string | null }
export declare class EtchvError extends Error {
  constructor(statusCode: number, detail: unknown, requestId?: string | null);
  statusCode: number;
  detail: unknown;
  requestId: string | null;
}
export declare class Etchv {
  constructor(options: { apiKey: string; baseUrl?: string; timeout?: number; fetch?: typeof globalThis.fetch });
  embedImage(image: Uint8Array, data: { [key: string]: JsonValue }, options?: RequestOptions): Promise<EmbedResult>;
  detectImage(image: Uint8Array, options?: RequestOptions): Promise<DetectionResult>;
}
