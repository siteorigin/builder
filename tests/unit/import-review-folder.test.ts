import { describe, expect, it } from 'vitest';
import { fromFolders } from '../../src/renderer/src/lib/import-folder';

describe('Import Review folder line', () => {
  it('tells same-named photos apart by their last two folders', () => {
    expect(fromFolders(['/Users/a/Trips/Shoreline/IMG_8614.png', '/Users/a/Trips/Mussels/IMG_8614.png'])).toEqual(['Trips/Shoreline', 'Trips/Mussels']);
    expect(fromFolders(['C:\\Photos\\Day 2\\IMG_8614.png'])).toEqual(['Photos/Day 2']);
  });
  it('grows the label until same-suffix folders differ', () => {
    const [a, b] = fromFolders(['/2025/DCIM/100APPLE/IMG_1.png', '/2026/DCIM/100APPLE/IMG_1.png']);
    expect(a).not.toBe(b);
    expect(a).toBe('2025/DCIM/100APPLE');
  });
  it('treats a backslash as a filename character on posix paths', () => {
    expect(fromFolders(['/Users/a/Photos/IMG\\8614.png'])).toEqual(['Users/a'.split('/').concat('Photos').slice(-2).join('/')]);
  });
  it('is empty for a file with no folder', () => {
    expect(fromFolders(['IMG_8614.png', '/IMG_8614.png'])).toEqual(['', '']);
  });
});
