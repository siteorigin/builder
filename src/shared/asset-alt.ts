/**
 * What a library picture says to people who can't see it, wherever the site publishes it without words of its own:
 * its suggested alt text. Its description is the library's note about the file, and is never published.
 */
import type { AssetRecord } from './types';

export function libraryAlt(asset: Pick<AssetRecord, 'altSuggestion'> | undefined): string {
  return typeof asset?.altSuggestion === 'string' ? asset.altSuggestion.trim() : '';
}
