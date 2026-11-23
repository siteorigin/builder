/**
 * Media worker (Electron utility process): makes the responsive copies of imported pictures, so the editor's
 * main process never decodes or resizes a photo. Started on demand by media-client.ts.
 */
import { renderVariants } from './image-variants';
import type { VariantReply, VariantRequest } from './media-client';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: VariantRequest }) => void) => void; postMessage: (m: VariantReply) => void } }).parentPort;

port.on('message', async ({ data: m }) => {
  try {
    const variants = await renderVariants(Buffer.from(m.data), m.mime, m.width);
    port.postMessage({ id: m.id, ok: true, variants: variants.map((v) => ({ width: v.width, data: new Uint8Array(v.data.buffer, v.data.byteOffset, v.data.byteLength) })) });
  } catch (e) {
    port.postMessage({ id: m.id, ok: false, error: (e as Error).message });
  }
});
