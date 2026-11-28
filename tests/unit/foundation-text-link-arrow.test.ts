/**
 * The arrow on Foundation's text links (`.so-btn--text`) is decorative, so it carries an empty alternative text
 * (issue #1467): a generated glyph without one joins the link's accessible name ("Read in English←").
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const RELEASES = ['resources/packs/foundation/pack.json', 'resources/packs-dev/foundation-alt/pack.json'];

describe.each(RELEASES)('%s', (file) => {
  const text = JSON.stringify(JSON.parse(readFileSync(file, 'utf8')));

  it('gives the text link arrow an empty alternative text in both directions', () => {
    expect(text).toContain(".so-btn--text::after { content: '→' / '';");
    expect(text).toContain(".so-btn--text:dir(rtl)::after { content: '←' / '';");
  });

  it('draws no arrow glyph without one', () => {
    expect(text).not.toMatch(/content:\s*'[→←]'\s*[;}]/);
  });
});
