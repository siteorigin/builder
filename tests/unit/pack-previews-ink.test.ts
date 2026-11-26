// The theme thumbnails are framed by the preview bridge's own inkBounds(), lifted out of its source. A Windows checkout
// has CRLF line endings, and the release build there failed with "The preview bridge has no inkBounds()".
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inkBoundsFrom, inkBoundsSource } from '../../scripts/packs/previews';

const bridge = readFileSync('src/runtime/bridge.client.js', 'utf8').replace(/\r\n/g, '\n');

describe('inkBoundsFrom', () => {
  it('lifts inkBounds() out of the bridge as an expression that runs it', () => {
    const source = inkBoundsFrom(bridge);
    expect(source.startsWith('(function inkBounds() {')).toBe(true);
    expect(source.endsWith('\n})()')).toBe(true);
    expect(inkBoundsSource()).toBe(source);
  });

  it('finds the same function in a checkout with Windows line endings', () => {
    expect(inkBoundsFrom(bridge.replace(/\n/g, '\r\n'))).toBe(inkBoundsFrom(bridge));
  });

  it('fails clearly when the bridge has no inkBounds()', () => {
    expect(() => inkBoundsFrom('function other() {\n}\n')).toThrow(/no inkBounds\(\)/);
  });
});
