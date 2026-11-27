import { useId } from 'react';
import { appMarkMarkup, detailFor, MARK_VIEWBOX } from '@shared/app-icon';

/**
 * The app's mark: the app icon's tile (src/shared/app-icon.ts), Addo on a selected web page on a sky tile. It always
 * carries its own tile, so it reads the same on light and dark backgrounds, and at small sizes it draws the icon's
 * simpler small-size version, as the packaged icons do.
 */
export function AppMark({ size = 36, className, title }: { size?: number; className?: string; title?: string }) {
  // Gradient, clip and filter ids must be unique per instance and safe inside url(#...).
  const id = 'mark-' + useId().replace(/[^\w-]/g, '');
  const markup = (title ? `<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>` : '') + appMarkMarkup(detailFor(size), id);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={MARK_VIEWBOX}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
