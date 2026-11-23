import { describe, expect, it } from 'vitest';
import { previewFile } from '../../src/renderer/src/lib/thumbs';

const photo = {
  file: 'static/images/studio.png',
  width: 2400,
  variants: [
    { width: 480, file: 'static/images/studio-480.png' },
    { width: 960, file: 'static/images/studio-960.png' },
    { width: 1440, file: 'static/images/studio-1440.png' }
  ]
};

describe('previewFile', () => {
  it('takes the smallest copy that covers every device pixel', () => {
    expect(previewFile(photo, 110, 1)).toBe('static/images/studio-480.png');
    expect(previewFile(photo, 110, 2)).toBe('static/images/studio-480.png');
    expect(previewFile(photo, 75, 3)).toBe('static/images/studio-480.png');
    expect(previewFile(photo, 300, 2)).toBe('static/images/studio-960.png');
    expect(previewFile(photo, 481, 1)).toBe('static/images/studio-960.png');
    expect(previewFile(photo, 720, 2)).toBe('static/images/studio-1440.png');
  });

  it('keeps the original when no copy is large enough', () => {
    expect(previewFile(photo, 1000, 2)).toBe('static/images/studio.png');
  });

  it('falls back to the original for an asset without copies or without a measured size', () => {
    expect(previewFile({ file: 'static/images/logo.svg' }, 110, 2)).toBe('static/images/logo.svg');
    expect(previewFile({ file: 'static/images/a.png', width: 300, variants: [] }, 110, 2)).toBe('static/images/a.png');
    expect(previewFile(photo, 0, 2)).toBe('static/images/studio.png');
    expect(previewFile(photo, NaN, 2)).toBe('static/images/studio.png');
  });

  it('treats a missing or bad pixel ratio as 1', () => {
    expect(previewFile(photo, 480, 0)).toBe('static/images/studio-480.png');
    expect(previewFile(photo, 480, NaN)).toBe('static/images/studio-480.png');
  });

  it('does not depend on the order the copies are listed in', () => {
    const shuffled = { ...photo, variants: [...photo.variants].reverse() };
    expect(previewFile(shuffled, 300, 2)).toBe('static/images/studio-960.png');
  });
});
