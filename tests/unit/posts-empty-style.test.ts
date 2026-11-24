import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Posts empty state styles', () => {
  const css = readFileSync('src/renderer/src/styles.css', 'utf8');

  it('styles only the direct newspaper icon, not the icon inside the primary button', () => {
    expect(css).toMatch(/^\.posts-empty > svg \{[^}]*width: 20px;[^}]*color: var\(--text-3\);[^}]*\}$/m);
    expect(css).not.toMatch(/^\.posts-empty svg\b/m);
  });
});
