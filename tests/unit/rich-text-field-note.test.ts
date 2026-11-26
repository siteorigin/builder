/** A rich text field's status line is a live region, but it only looks like an error while it holds a message (#900). */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The renderer store reads `window` when it loads, so the stub is in place before the static import below.
vi.hoisted(() => {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: { platform: 'test' }
  };
});
// @ts-expect-error TS6142: the Node type-check project sets no --jsx; Vitest compiles the component itself.
import { RichTextField } from '../../src/renderer/src/components/RichTextField';

describe('RichTextField status line', () => {
  it('keeps the live region mounted without the error styling while there is no note', () => {
    const html = renderToStaticMarkup(createElement(RichTextField, { value: 'Hello', onCommit: () => undefined, pages: [] }));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('field-error');
  });
});
