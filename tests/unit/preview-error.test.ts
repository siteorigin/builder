/**
 * What the canvas can offer for a preview error (#738): the component it came from, for Open source, and the change
 * that could have caused it, for Revert.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryInfo } from '@shared/api';
import type { ComponentDefinition } from '@shared/types';
import { appliedSteps, errorComponent, revertStep, stillNewest } from '../../src/renderer/src/lib/preview-error';

const def = (id: string, extra: Partial<ComponentDefinition> = {}) => ({ id, kind: 'managed', name: id, ...extra }) as ComponentDefinition;
const components = {
  'theme.hero': def('theme.hero'),
  'project.pricing-card': def('project.pricing-card', { kind: 'code', sourcePath: 'src/lib/components/PricingCard.svelte' }),
  'theme.hero-alt': def('theme.hero-alt')
};

describe('errorComponent', () => {
  it('names a project code component from a stack frame URL with a query and line', () => {
    const stack = `TypeError: Cannot read properties of undefined (reading 'price')
    at PricingCard (http://localhost:5173/src/lib/components/PricingCard.svelte?t=1712:41:17)
    at Page (http://localhost:5173/src/routes/+page.svelte:12:3)`;
    expect(errorComponent([stack], components)).toBe('project.pricing-card');
  });

  it('names a generated component from a /@fs path and Firefox-style frames', () => {
    const stack = `Hero@http://localhost:5173/@fs/Users/me/site/.siteorigin/cache/dev/src/lib/siteorigin/generated/theme-hero.svelte:8:5`;
    expect(errorComponent([stack], components)).toBe('theme.hero');
  });

  it('takes the frame nearest the throw', () => {
    const stack = `Error: boom
    at http://h/src/lib/siteorigin/generated/theme-hero-alt.svelte:3:1
    at http://h/src/lib/siteorigin/generated/theme-hero.svelte:9:1`;
    expect(errorComponent([stack], components)).toBe('theme.hero-alt');
  });

  it('reads a Vite build error id and a Windows path', () => {
    expect(errorComponent([undefined, 'C:\\site\\.siteorigin\\cache\\dev\\src\\lib\\components\\PricingCard.svelte'], components)).toBe('project.pricing-card');
    expect(errorComponent(['/abs/site/src/lib/siteorigin/generated/theme-hero.svelte'], components)).toBe('theme.hero');
  });

  it('never matches part of a longer file name, and names nothing for the runtime or a page', () => {
    expect(errorComponent(['at http://h/src/lib/siteorigin/generated/x-theme-hero.svelte:1:1'], components)).toBeNull();
    expect(errorComponent(['at http://h/src/lib/siteorigin/runtime/Link.svelte:1:1\n at http://h/src/routes/+page.svelte:2:2'], components)).toBeNull();
    expect(errorComponent(['Cannot read properties of undefined'], components)).toBeNull();
    expect(errorComponent(['at http://h/node_modules/ui/src/lib/components/PricingCard.svelte:1:1'], components)).toBeNull();
    expect(errorComponent([], {})).toBeNull();
  });
});

const history = (entries: Array<[string, boolean, number?]>): HistoryInfo => ({
  canUndo: true,
  canRedo: false,
  entries: entries.map(([id, applied, revision]) => ({ id, label: `Edit ${id}`, source: 'user', time: '', revision: revision ?? 1, applied }))
});

describe('revertStep', () => {
  it('offers the newest change when the page worked before it', () => {
    const before = history([['a', true]]);
    const after = history([['a', true], ['b', true]]);
    expect(revertStep(after, appliedSteps(before))?.id).toBe('b');
  });

  it('offers nothing when the page was never seen working (an error there on open)', () => {
    expect(revertStep(history([['a', true]]), null)).toBeNull();
  });

  it('offers nothing when no change came since the page last worked', () => {
    const h = history([['a', true], ['b', true]]);
    expect(revertStep(h, appliedSteps(h))).toBeNull();
  });

  it('offers nothing after an Undo, and the redone change after a Redo', () => {
    const both = history([['a', true], ['b', true]]);
    const undone = history([['a', true], ['b', false]]);
    expect(revertStep(undone, appliedSteps(both))).toBeNull();
    expect(revertStep(both, appliedSteps(undone))?.id).toBe('b');
  });

  it('offers a step that later edits joined after the page last worked', () => {
    const typing = history([['a', true, 1], ['b', true, 2]]);
    const more = history([['a', true, 1], ['b', true, 5]]);
    expect(revertStep(more, appliedSteps(typing))).toMatchObject({ id: 'b', label: 'Edit b' });
    expect(stillNewest(more, revertStep(more, appliedSteps(typing))!.key)).toBe(true);
    // Another edit joined it, or a new one came, after the error: the offer no longer holds.
    expect(stillNewest(history([['a', true, 1], ['b', true, 6]]), 'b@5')).toBe(false);
    expect(stillNewest(history([['a', true, 1], ['b', false, 5]]), 'b@5')).toBe(false);
  });

  it('offers nothing with an empty history', () => {
    expect(revertStep(history([]), [])).toBeNull();
  });
});
