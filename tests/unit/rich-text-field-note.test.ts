/** A rich text field's status line is a live region, but it only looks like an error while it holds a message (#900). */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Field = (props: Record<string, unknown>) => ReturnType<typeof createElement>;
let RichTextField: Field;

beforeAll(async () => {
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: { platform: 'test' }
  };
  const path = ['..', '..', 'src', 'renderer', 'src', 'components', 'RichTextField.tsx'].join('/');
  RichTextField = ((await import(/* @vite-ignore */ path)) as { RichTextField: Field }).RichTextField;
});

describe('RichTextField status line', () => {
  it('keeps the live region mounted without the error styling while there is no note', () => {
    const html = renderToStaticMarkup(createElement(RichTextField, { value: 'Hello', onCommit: () => undefined, pages: [] }));
    expect(html).toContain('role="status"');
    expect(html).not.toContain('field-error');
  });
});
