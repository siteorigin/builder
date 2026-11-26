import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('Posts empty state styles', () => {
  const css = readFileSync('src/renderer/src/panels/PostsPanel.css', 'utf8');

  it('styles only the direct newspaper icon, not the icon inside the primary button', () => {
    expect(css).toMatch(/^\s*\.posts-empty > svg \{[^}]*width: 20px;[^}]*color: var\(--text-3\);[^}]*\}$/m);
    expect(css).not.toMatch(/^\s*\.posts-empty svg\b/m);
  });
});

describe('the collection settings dialog’s lists (#895)', () => {
  const dialog = readFileSync('src/renderer/src/panels/CollectionSchemaDialog.tsx', 'utf8');
  const css = readFileSync('src/renderer/src/panels/CollectionSchemaDialog.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const propSchema = readFileSync('src/renderer/src/panels/PropSchemaEditor.css', 'utf8');
  const listClasses = [...dialog.matchAll(/<(?:ul|ol|li)\b[^>]*?className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));
  // The declarations of each rule whose selector list names `.c` itself (not `.c-head`, nor `.c` inside another selector).
  const rulesFor = (c: string) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((m) => m[1].split(',').some((s) => s.trim() === `.${c}`)).map((m) => m[2]);

  it('uses classes of its own, which the component settings’ bordered item-field box does not style', () => {
    expect(dialog).toContain("import './CollectionSchemaDialog.css';");
    expect(new Set(listClasses)).toEqual(new Set(['cs-fields', 'cs-field', 'cs-groups', 'cs-group']));
    for (const c of listClasses) {
      expect(propSchema, c).not.toMatch(new RegExp(`\\.${c}\\b`));
      expect(rulesFor(c), c).not.toHaveLength(0);
    }
    // The lists themselves draw no box, so an empty or short list never shows one: a field's row is its own card.
    for (const c of ['cs-fields', 'cs-groups']) for (const body of rulesFor(c)) expect(body, c).not.toMatch(/border/);
  });

  it('shows a list only when it has rows, and a grouping by its name alone', () => {
    expect(dialog).toMatch(/\{draft\.fields\.length > 0 && \(\s*<ol className="cs-fields"[\s>]/);
    expect(dialog).toMatch(/\{draft\.taxonomies\.length > 0 && \(\s*<ul className="cs-groups"[\s>]/);
    expect(dialog).not.toContain('{t.id}</code>');
  });
});

