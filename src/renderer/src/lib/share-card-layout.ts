/**
 * How each platform lays out a shared link's card (#705): its width, what it does with the sharing image, and how
 * many lines of title and description it keeps. The platforms publish only some of this, so the numbers are the ones
 * their image guides and observed cards agree on: close enough to show a badly framed picture or an overlong title,
 * without promising a pixel. Sizes are CSS pixels of the card at full size; the editor scales a card that has less
 * room as one piece, so its crop and its line breaks stay the same.
 */
import type { AssetRecord } from '@shared/types';

export type SharePlatform = 'feed' | 'x' | 'messages' | 'chat';

/** The cards shown, in order. The names say which kind of place each is; the cards carry no logos or brand marks. */
export const SHARE_PLATFORMS: ReadonlyArray<{ id: SharePlatform; name: string; place: string }> = [
  { id: 'feed', name: 'Facebook', place: 'Social feed' },
  { id: 'x', name: 'X', place: 'Social timeline' },
  { id: 'messages', name: 'WhatsApp', place: 'Phone messages' },
  { id: 'chat', name: 'Slack', place: 'Team chat' }
];

export interface ShareImageBox {
  /** `top`: the card's whole width, above its text. `side`: a small square beside the text. `below`: under the text. */
  at: 'top' | 'side' | 'below';
  width: number;
  /** Null where the picture's own size isn't known: it takes its own shape inside `maxHeight`. */
  height: number | null;
  maxHeight: number;
  /** `cover`: centre-cropped to fill the box. `whole`: all of it shows, shrunk if need be. */
  fit: 'cover' | 'whole';
}

export interface ShareCardLayout {
  width: number;
  /** Null: the card is text alone. */
  image: ShareImageBox | null;
  titleLines: number;
  /** 0: the card shows no description. */
  descriptionLines: number;
  /**
   * Where the host reads: over the title, under the text, or under the whole card ("From example.com"). With
   * `overlay`, the title is a chip over the picture.
   */
  host: 'above' | 'below' | 'outside';
  overlay: boolean;
  /** What the platform does with this picture that the card alone doesn't say. */
  note: string | null;
}

/** The picture's own size, as the library measured it (either side can be unknown), and its file's size in bytes. */
export type ShareImageSize = Pick<AssetRecord, 'width' | 'height'> & Partial<Pick<AssetRecord, 'bytes'>>;

/** What stands between this picture and every platform's card, whatever its shape. */
export function pictureWarning(picture: Pick<AssetRecord, 'mime'> | undefined, originalMissing: boolean): string | null {
  if (!picture) return null;
  // The shared page names the original alone, whatever copies of it are left.
  if (originalMissing) return 'Its file is missing from the project.';
  return picture.mime === 'image/svg+xml' ? 'It is an SVG, which link cards generally can’t show. Choose a JPEG or PNG.' : null;
}

/** Slack's attachment bounds for a picture. */
const CHAT_IMAGE = { width: 360, height: 500 } as const;

/** A picture's size shrunk (never grown) to fit inside a box, keeping its shape. */
export function fitWithin(width: number, height: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: width * scale, height: height * scale };
}

const top = (width: number, ratio: number): ShareImageBox => ({ at: 'top', width, height: width / ratio, maxHeight: width / ratio, fit: 'cover' });
const side = (size: number): ShareImageBox => ({ at: 'side', width: size, height: size, maxHeight: size, fit: 'cover' });

const measured = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
/** Whether a side is known to fall short of `min`. */
const under = (n: number | undefined, min: number) => measured(n) && n < min;

/** One platform's card for a link with this sharing picture (null: the link has none). */
export function shareCardLayout(platform: SharePlatform, picture: ShareImageSize | null): ShareCardLayout {
  const w = picture?.width;
  const h = picture?.height;
  const sized = measured(w) && measured(h);
  switch (platform) {
    case 'feed': {
      const base = { width: 500, titleLines: 2, descriptionLines: 1, host: 'above', overlay: false } as const;
      if (!picture) return { ...base, image: null, note: null };
      if (under(w, 200) || under(h, 200)) return { ...base, image: null, note: 'Under 200 × 200 pixels, Facebook leaves the picture out.' };
      if (sized && w >= 600 && h >= 315) return { ...base, image: top(500, 1.91), note: null };
      return {
        ...base,
        image: side(100),
        note: sized ? 'Under 600 × 315 pixels, Facebook shows the picture as a small thumbnail.' : 'The picture’s size isn’t known, so it is shown as a small thumbnail.'
      };
    }
    case 'x': {
      // The exported page asks for the large card whenever it has a picture, and for the small one without.
      if (!picture) return { width: 500, image: side(96), titleLines: 1, descriptionLines: 2, host: 'above', overlay: false, note: null };
      return {
        width: 500,
        image: top(500, 2),
        titleLines: 1,
        descriptionLines: 0,
        host: 'outside',
        overlay: true,
        note: under(w, 300) || under(h, 157) ? 'Under 300 × 157 pixels, X may leave the picture out.' : 'With a large picture, X shows no description.'
      };
    }
    case 'messages': {
      const base = { width: 280, titleLines: 2, descriptionLines: 2, host: 'below', overlay: false } as const;
      if (!picture) return { ...base, image: null, note: null };
      if (under(w, 100) || under(h, 100)) return { ...base, image: null, note: 'Under 100 × 100 pixels, WhatsApp leaves the picture out.' };
      if (sized && Math.max(w / h, h / w) > 4) return { ...base, image: side(64), note: 'Beyond 4:1, WhatsApp may show the picture as a small thumbnail, or not at all.' };
      if (measured(w) && w >= 300) return { ...base, image: top(280, 1.91), note: (picture.bytes ?? 0) > 600_000 ? 'Over 600 KB, WhatsApp may show the picture smaller, or not at all.' : null };
      return {
        ...base,
        image: side(64),
        note: measured(w) ? 'Under 300 pixels wide, WhatsApp shows the picture as a small thumbnail.' : 'The picture’s size isn’t known, so it is shown as a small thumbnail.'
      };
    }
    case 'chat': {
      const base = { width: 380, titleLines: 2, descriptionLines: 3, host: 'above', overlay: false, note: null } as const;
      if (!picture) return { ...base, image: null };
      const box = sized ? fitWithin(w, h, CHAT_IMAGE.width, CHAT_IMAGE.height) : { width: CHAT_IMAGE.width, height: null };
      return { ...base, image: { at: 'below', ...box, maxHeight: CHAT_IMAGE.height, fit: 'whole' } };
    }
  }
}
