/**
 * Media worker (Electron utility process): checks and makes the responsive copies of imported pictures, so the
 * editor's main process never decodes or resizes a photo. Started on demand by media-client.ts.
 */
import { handleVariantRequest } from './image-variants';
import type { VariantReply, VariantRequest } from './media-client';

const port = (process as unknown as { parentPort: { on: (e: 'message', cb: (ev: { data: VariantRequest }) => void) => void; postMessage: (m: VariantReply) => void } }).parentPort;

port.on('message', async ({ data: m }) => port.postMessage(await handleVariantRequest(m, (early) => port.postMessage(early))));
