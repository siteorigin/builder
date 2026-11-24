/**
 * Downloadable documents: files an author imports so visitors can download them from the site (a PDF guide, a
 * booking form, a price list). Only formats a browser saves or shows as a document are accepted, never one it
 * would run as part of the site (HTML, SVG, scripts).
 */
export interface DocumentFormat {
  mime: string;
  /** The kind of document in a few words, for people: "PDF", "Word document". */
  label: string;
}

export const DOCUMENT_FORMATS: Readonly<Record<string, DocumentFormat>> = {
  pdf: { mime: 'application/pdf', label: 'PDF' },
  doc: { mime: 'application/msword', label: 'Word document' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word document' },
  xls: { mime: 'application/vnd.ms-excel', label: 'Excel spreadsheet' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', label: 'Excel spreadsheet' },
  ppt: { mime: 'application/vnd.ms-powerpoint', label: 'PowerPoint presentation' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: 'PowerPoint presentation' },
  odt: { mime: 'application/vnd.oasis.opendocument.text', label: 'OpenDocument text' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet', label: 'OpenDocument spreadsheet' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation', label: 'OpenDocument presentation' },
  txt: { mime: 'text/plain', label: 'Text file' },
  csv: { mime: 'text/csv', label: 'CSV file' },
  zip: { mime: 'application/zip', label: 'ZIP archive' }
};

/** File extensions the importer accepts as documents (for file pickers and file names). */
export const DOCUMENT_EXTENSIONS = Object.keys(DOCUMENT_FORMATS);

/** The format a file name's extension says it is, or null when it is not a document the library takes. */
export function documentFormat(fileName: string): (DocumentFormat & { ext: string }) | null {
  const m = /\.([a-z0-9]+)$/i.exec(fileName.trim());
  const ext = m?.[1].toLowerCase();
  return ext && Object.hasOwn(DOCUMENT_FORMATS, ext) ? { ext, ...DOCUMENT_FORMATS[ext] } : null;
}

/** Whether a MIME type is one of the document formats. */
export const isDocumentMime = (mime: unknown): boolean => typeof mime === 'string' && DOCUMENT_EXTENSIONS.some((ext) => DOCUMENT_FORMATS[ext].mime === mime);

/** "PDF", "Word document": what a document is, from its MIME type, else from its file name. */
export function documentTypeLabel(mime: string, fileName = ''): string {
  for (const f of Object.values(DOCUMENT_FORMATS)) if (f.mime === mime) return f.label;
  return documentFormat(fileName)?.label ?? 'Document';
}
