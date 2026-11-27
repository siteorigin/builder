/**
 * The shared Switch is a button that toggles a value and nothing else: inside a <form> it must never submit it, so it
 * renders type="button" (a button without a type is a submit button).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type Ui = typeof import('../../src/renderer/src/components/ui');
let ui: Ui;

beforeAll(async () => {
  // The renderer's preload bridge and window, as little of them as importing the module needs.
  (globalThis as unknown as { window: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: { platform: 'test' }
  };
  ui = await import('../../src/renderer/src/components/ui');
});

describe('Switch', () => {
  it('is a plain button, so a switch inside a form never submits it', () => {
    const html = renderToStaticMarkup(createElement('form', null, createElement(ui.Switch, { checked: true, onChange: () => undefined, label: 'Open in a new tab' })));
    expect(html).toMatch(/<button[^>]*\btype="button"[^>]*role="switch"/);
  });

  it('keeps that in a switch row', () => {
    const html = renderToStaticMarkup(createElement(ui.SwitchRow, { checked: false, onChange: () => undefined, label: 'Decorative image', hint: 'Nothing to describe.' }));
    expect(html).toMatch(/<button[^>]*\btype="button"[^>]*role="switch"/);
  });
});
