import { useId } from 'react';
import { appMarkMarkup, MARK_VIEWBOX } from '@shared/app-icon';

/**
 * The app's mark: the app icon's tile (src/shared/app-icon.ts), SiteOrigin's Addo in charcoal on white. It always
 * carries its own tile, with a faint edge, so it reads the same on light and dark backgrounds, and at small sizes it
 * draws the icon's heavier small-size version, as the packaged icons do.
 */
export function AppMark({ size = 36, className, title }: { size?: number; className?: string; title?: string }) {
  // Gradient, clip and filter ids must be unique per instance and safe inside url(#...).
  const id = 'mark-' + useId().replace(/[^\w-]/g, '');
  const markup = (title ? `<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>` : '') + appMarkMarkup(size, id);
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
