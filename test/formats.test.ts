import test from 'node:test';
import assert from 'node:assert/strict';
import { Etchv, EtchvError } from '../src/index.js';

const id = 'ab'.repeat(32);
const mock = (handler: (url: URL, init: any) => Response | Promise<Response>) => handler as unknown as typeof fetch;
const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap(part => typeof part === 'string' ? Array.from(part, c => c.charCodeAt(0)) : part));
const tail = '\0test\xffbytes';
const ts = new Uint8Array(377);
ts[0] = ts[188] = ts[376] = 0x47;

const samples: [media: 'videos' | 'documents', mime: string, file: Uint8Array, extension: string][] = [
  ['videos', 'video/webm', bytes([0x1a, 0x45, 0xdf, 0xa3], tail), 'webm'],
  ['videos', 'video/x-matroska', bytes([0x1a, 0x45, 0xdf, 0xa3], tail), 'mkv'],
  ['videos', 'video/mpeg', bytes([0, 0, 1, 0xba], tail), 'mpg'],
  ['videos', 'video/mp2t', ts, 'ts'],
  ['videos', 'video/x-msvideo', bytes('RIFF', [0, 0, 0, 0], 'AVI ', tail), 'avi'],
  ['documents', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', bytes('PK', [3, 4], 'word/', tail), 'docx'],
  ['documents', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', bytes('PK', [3, 4], 'ppt/', tail), 'pptx'],
];

test('new video and Office results map to their extensions only with matching bytes', async () => {
  for (const [media, mime, file, extension] of samples) {
    for (const [body, valid] of [[file, true], [bytes('%PDF-1.7', tail), false]] as const) {
      const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(url => {
        assert.equal(url.pathname, `/watermarks/${media}`);
        return new Response(body, { headers: { 'content-type': mime, 'x-watermark-id': id } });
      }) });
      const embed = media === 'videos' ? sdk.embedVideo(body, { recipient: 'test' }) : sdk.embedDocument(body, { recipient: 'test' });
      if (valid) {
        const result = await embed;
        assert.deepEqual([result.contentType, result.filename], [mime, `image-watermarked.${extension}`]);
      } else {
        await assert.rejects(embed, EtchvError);
      }
    }
  }
});

test('document detection units carry their package part', async () => {
  const sdk = new Etchv({ apiKey: 'test-key', fetch: mock(() => Response.json({ watermarked: true, confidence: 0.9, watermark_id: id, units: [
    { index: 0, watermarked: true, confidence: 0.9, watermark_id: id, part: 'ppt/media/image1.png' },
    { index: 1, watermarked: false, confidence: 0.5, watermark_id: null },
  ] })) });
  const result = await sdk.detectDocument(bytes('PK', [3, 4], 'ppt/'), { filename: 'deck.pptx' });
  assert.deepEqual(result.units.map(unit => unit.part), ['ppt/media/image1.png', null]);
});
