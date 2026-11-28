import { describe, expect, it } from 'vitest';
import { fromFolder } from '../../src/renderer/src/lib/import-folder';

describe('Import Review folder line', () => {
  it('tells same-named photos apart by their last two folders', () => {
    expect(fromFolder('/Users/a/Trips/Shoreline/IMG_8614.png')).toBe('Trips/Shoreline');
    expect(fromFolder('/Users/a/Trips/Mussels/IMG_8614.png')).toBe('Trips/Mussels');
    expect(fromFolder('C:\\Photos\\Day 2\\IMG_8614.png')).toBe('Photos/Day 2');
  });
  it('is empty for a file with no folder', () => {
    expect(fromFolder('IMG_8614.png')).toBe('');
    expect(fromFolder('/IMG_8614.png')).toBe('');
  });
});
