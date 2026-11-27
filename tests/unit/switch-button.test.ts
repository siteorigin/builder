/**
 * The shared Switch is a button that toggles a value and nothing else: inside a <form> it must never submit it, so it
 * renders type="button" (a button without a type is a submit button).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// The module is .tsx, which the tests' tsconfig (no --jsx) can't type check, so it is imported by a specifier tsc doesn't
// resolve and typed with just the props these tests pass.
const UI_MODULE = '../../src/renderer/src/components/ui';
type SwitchProps = { checked: boolean; onChange: (checked: boolean) => void; label: string; hint?: string };
type Ui = { Switch: ComponentType<SwitchProps>; SwitchRow: ComponentType<SwitchProps> };
let ui: Ui;

beforeAll(async () => {
  // The renderer's preload bridge and window, as little of them as importing the module needs.
  (globalThis as unknown as { window: unknown }).window ??= {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: { platform: 'test' }
  };
  ui = (await import(/* @vite-ignore */ UI_MODULE)) as Ui;
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
