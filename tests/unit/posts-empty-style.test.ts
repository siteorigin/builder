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
  const posts = readFileSync('src/renderer/src/panels/PostsPanel.css', 'utf8');
  const propSchema = readFileSync('src/renderer/src/panels/PropSchemaEditor.css', 'utf8');
  const listClasses = [...dialog.matchAll(/<(?:ul|li)\b[^>]*?className="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/));

  it('uses classes of its own, which the component settings’ bordered item-field box does not style', () => {
    expect(new Set(listClasses)).toEqual(new Set(['collection-fields', 'collection-field']));
    for (const c of listClasses) {
      expect(propSchema, c).not.toMatch(new RegExp(`\\.${c}\\b`));
      expect(posts, c).toMatch(new RegExp(`^\\s*\\.${c} \\{`, 'm'));
    }
    // The list itself has no box: each row has its own.
    expect(posts).toMatch(/^\s*\.collection-fields \{(?![^}]*border)[^}]*\}$/m);
  });

  it('shows a list only when it has rows, and a grouping by its name alone', () => {
    expect(dialog).toMatch(/\{draft\.fields\.length > 0 && \(\s*<ul className="collection-fields">/);
    expect(dialog).toMatch(/\{draft\.taxonomies\.length > 0 && \(\s*<ul className="collection-fields">/);
    expect(dialog).not.toContain('{t.id}</code>');
  });
});

