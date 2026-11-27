/** Downloadable documents in the library, as the link editor and Assets show and import them. */
import type { AssetRecord, ProjectState } from '@shared/types';
import { documentTypeLabel } from '@shared/document-files';
import { formatBytes } from './storage';

/** A library document a link can go to: one with a file (a record edited by hand may lack one). */
export function isLibraryDocument(a: AssetRecord | undefined | null): a is AssetRecord {
  return a?.kind === 'document' && typeof a.file === 'string' && !!a.file;
}

/** The library's documents, by name. */
export function libraryDocuments(state: ProjectState): AssetRecord[] {
  const created = (a: AssetRecord) => (typeof a.createdAt === 'string' ? a.createdAt : '');
  return Object.values(state.assets.assets)
    .filter(isLibraryDocument)
    .sort((a, b) => documentName(a).localeCompare(documentName(b)) || created(a).localeCompare(created(b)));
}

export const documentName = (a: AssetRecord) => (typeof a.name === 'string' && a.name.trim()) || 'Untitled document';

/** The file a document came from, as a visitor's download is named: "Exhibitor guide.pdf". */
export const documentFileName = (a: AssetRecord) => (typeof a.originalName === 'string' && a.originalName.trim()) || (typeof a.file === 'string' ? a.file.split('/').pop() : '') || 'No file';

/** "PDF · 2.4 MB": what kind of file it is and how big, for a list where the name already says which. */
export function documentFacts(a: AssetRecord): string {
  return [documentTypeLabel(typeof a.mime === 'string' ? a.mime : '', typeof a.file === 'string' ? a.file : ''), typeof a.bytes === 'number' ? formatBytes(a.bytes) : ''].filter(Boolean).join(' · ');
}

/** "Exhibitor guide.pdf · PDF · 2.4 MB": what the file is, for telling documents apart. */
export function documentDetails(a: AssetRecord): string {
  return [documentFileName(a), documentTypeLabel(typeof a.mime === 'string' ? a.mime : '', typeof a.file === 'string' ? a.file : ''), typeof a.bytes === 'number' ? formatBytes(a.bytes) : ''].filter(Boolean).join(' · ');
}

/**
 * Names for a list of documents: each document's name, with its file name added when another document has the
 * same name, and its ID when the file names match too (two versions of "Exhibitor guide.pdf").
 */
export function documentLabels(docs: AssetRecord[]): Map<string, string> {
  const count = (key: (a: AssetRecord) => string) => {
    const m = new Map<string, number>();
    for (const a of docs) m.set(key(a), (m.get(key(a)) ?? 0) + 1);
    return m;
  };
  const byName = count((a) => documentName(a).toLowerCase());
  const byFile = count((a) => `${documentName(a).toLowerCase()}\n${documentFileName(a).toLowerCase()}`);
  const out = new Map<string, string>();
  for (const a of docs) {
    const name = documentName(a);
    if ((byName.get(name.toLowerCase()) ?? 0) < 2) out.set(a.id, name);
    else if ((byFile.get(`${name.toLowerCase()}\n${documentFileName(a).toLowerCase()}`) ?? 0) < 2) out.set(a.id, `${name} (${documentFileName(a)})`);
    else out.set(a.id, `${name} (${documentFileName(a)}, ${a.id})`);
  }
  return out;
}
