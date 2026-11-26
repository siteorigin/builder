/**
 * The project's own check of the assistant's source tool (#680): an AI run's batch reaches a source only with the
 * grant write_source_converter gives for the one change it tested, and only as that change. Everything that decides
 * where the source is read and with which of the user's secrets (its kind, settings, collection, name and removal
 * policy) stays exactly as saved, and the converter it writes reads nothing its own way.
 */
import type { EditOperation } from '@shared/ops';
import type { SourceDoc } from '@shared/types';
import { sourceConversionKey, sourceFingerprint, type SourceWriteGrant } from '@shared/sources';
import { readsItsOwnWay } from './converter';

/** Why a batch asks for more than its source grant allows, or null. */
export function sourceWriteRefusal(ops: readonly EditOperation[], grant: SourceWriteGrant, sources: Record<string, SourceDoc> | undefined): string | null {
  const op = ops[0];
  if (ops.length !== 1 || op?.type !== 'source.upsert') return 'The source tool writes one source’s mapping or converter, and nothing else.';
  if (op.sourceId !== grant.sourceId) return 'The source tool writes only the source it tested.';
  const saved = sources && Object.hasOwn(sources, grant.sourceId) ? sources[grant.sourceId] : undefined;
  if (!saved) return 'That source is no longer in the project.';
  if (sourceFingerprint(saved) !== grant.base) return `“${saved.name}” changed since its new mapping or converter was tested. Test it again.`;
  const kept = (d: { name: string; adapter: string; collectionId: string; config?: unknown; removal?: unknown }) =>
    sourceFingerprint({ name: d.name, adapter: d.adapter, collectionId: d.collectionId, config: d.config ?? {}, removal: d.removal ?? null } as unknown as SourceDoc);
  if (kept(op) !== kept(saved)) return `The source tool changes only how “${saved.name}”’s records are put in shape: its settings stay as the author saved them.`;
  if (op.converter === undefined ? op.mapping === undefined : op.mapping !== undefined) return 'The source tool writes a mapping or a converter.';
  if (sourceConversionKey(op) !== grant.change) return 'The source tool writes only the mapping or converter it tested.';
  if (typeof op.converter === 'string' && readsItsOwnWay(op.converter)) return 'A converter the assistant writes reads its records as the source’s settings do: it has no fetchAll.';
  if (saved.converter && (typeof saved.converter.code !== 'string' || readsItsOwnWay(saved.converter.code)))
    return `“${saved.name}” reads its source its own way, with its converter’s fetchAll: only the author changes how it is read, in Connect external source.`;
  return null;
}
