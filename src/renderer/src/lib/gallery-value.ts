/**
 * An entry's gallery field edited in the Content writer (#1320): the Inspector's list editor drives it, and each of its
 * edits (photos chosen from Assets, a photo moved, removed, given a caption or a description) becomes the gallery's
 * whole new value, sent as one entry.update so it is one undo step.
 */
import type { AssetRecord, GalleryItem, ImageValue } from '@shared/types';
import { MAX_GALLERY_PHOTOS } from '@shared/types';
import { newId } from '@shared/ids';

/** What the list editor asks of a gallery (see PropEditors' ListOp); adding a photo by hand is not one of them. */
export type GalleryEdit =
  | { kind: 'pick'; assetIds: string[] }
  | { kind: 'remove'; itemId: string }
  | { kind: 'move'; itemId: string; index: number }
  | { kind: 'field'; itemId: string; field: string; value: unknown };

/**
 * The gallery after one edit, with the IDs of the photos it added; null when the edit changes nothing or cannot be
 * made (a photo that is no longer there, a picture removed from Assets, more photos than a gallery holds). A photo's
 * picture removed in its row is the photo removed. A chosen
 * picture starts with no description of its own, so it shows the library's suggested alt text until one is written.
 */
export function editGallery(rows: readonly GalleryItem[], edit: GalleryEdit, assets: Record<string, Pick<AssetRecord, 'id' | 'kind'>>, makeId: () => string = () => newId('i')): { rows: GalleryItem[]; added: string[] } | null {
  const at = 'itemId' in edit ? rows.findIndex((r) => r.id === edit.itemId) : -1;
  switch (edit.kind) {
    case 'pick': {
      if (!edit.assetIds.length || rows.length + edit.assetIds.length > MAX_GALLERY_PHOTOS) return null;
      if (edit.assetIds.some((id) => !Object.hasOwn(assets, id) || assets[id].kind !== 'image')) return null;
      const taken = new Set(rows.map((r) => r.id));
      const added = edit.assetIds.map((assetId) => {
        let id = makeId();
        while (taken.has(id)) id = makeId();
        taken.add(id);
        return { id, image: { assetId, alt: '' }, caption: '' };
      });
      return { rows: [...rows, ...added], added: added.map((r) => r.id) };
    }
    case 'remove':
      return at < 0 ? null : { rows: rows.filter((_, i) => i !== at), added: [] };
    case 'move': {
      if (at < 0 || !Number.isInteger(edit.index) || edit.index < 0 || edit.index >= rows.length || edit.index === at) return null;
      const next = rows.filter((_, i) => i !== at);
      next.splice(edit.index, 0, rows[at]);
      return { rows: next, added: [] };
    }
    case 'field': {
      if (at < 0) return null;
      const row = rows[at];
      let changed: GalleryItem;
      if (edit.field === 'caption') changed = { ...row, caption: typeof edit.value === 'string' ? edit.value : '' };
      else if (edit.field === 'image') {
        const v = edit.value as Partial<ImageValue> | null;
        // A photo always has its picture: removing the picture removes the photo.
        if (!v || typeof v !== 'object' || typeof v.assetId !== 'string' || !v.assetId) return { rows: rows.filter((_, i) => i !== at), added: [] };
        changed = { ...row, image: { assetId: v.assetId, alt: typeof v.alt === 'string' ? v.alt : '', ...(v.decorative ? { decorative: true } : {}) } };
      } else return null;
      if (JSON.stringify(changed) === JSON.stringify(row)) return null;
      return { rows: rows.map((r, i) => (i === at ? changed : r)), added: [] };
    }
  }
}

/**
 * A run of changes sent from one gallery editor whose last has not landed yet: the gallery as it was saved when the
 * run began and every gallery it sent since (`known`), and the last it sent (`rows`).
 */
export interface GallerySending {
  known: Set<string>;
  rows: GalleryItem[];
}

/**
 * What the next change builds on: while the project holds the gallery as the run began or as one of its changes left
 * it, the run's last (still to land); otherwise the project's own, so a change made elsewhere stays. With the run as
 * it is once the change is sent.
 */
export function nextBase(sending: GallerySending | null, saved: readonly GalleryItem[]): { base: GalleryItem[]; send: (rows: GalleryItem[]) => GallerySending } {
  const at = JSON.stringify(saved);
  const ours = !!sending && sending.known.has(at);
  return {
    base: ours ? sending!.rows : [...saved],
    send: (rows) => ({ known: new Set([...(ours ? sending!.known : [at]), JSON.stringify(rows)]), rows })
  };
}
