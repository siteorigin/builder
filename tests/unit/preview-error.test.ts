/**
 * What the canvas can offer for a preview error (#738): the component it came from, for Open source, and the change
 * that could have caused it, for Revert.
 */
import { describe, expect, it } from 'vitest';
import type { HistoryInfo } from '@shared/api';
import type { ComponentDefinition } from '@shared/types';
import { appliedSteps, errorComponent, projectPath, revertStep } from '../../src/renderer/src/lib/preview-error';

const def = (id: string, extra: Partial<ComponentDefinition> = {}) => ({ id, kind: 'managed', name: id, ...extra }) as ComponentDefinition;
const components = {
  'theme.hero': def('theme.hero'),
  'project.pricing-card': def('project.pricing-card', { kind: 'code', sourcePath: 'src/lib/components/PricingCard.svelte' }),
  'theme.hero-alt': def('theme.hero-alt')
};

const DIR = '/Users/me/Sites/harbour';

describe('errorComponent', () => {
  it('names a project code component from a stack frame URL with a query and line', () => {
    const stack = `TypeError: Cannot read properties of undefined (reading 'price')
    at PricingCard (http://localhost:5173/src/lib/components/PricingCard.svelte?t=1712:41:17)
    at Page (http://localhost:5173/src/routes/+page.svelte:12:3)`;
    expect(errorComponent([stack], components, DIR)).toBe('project.pricing-card');
  });

  it('names a generated component from a /@fs address of the served copy, in a Firefox-style frame', () => {
    const stack = `Hero@http://localhost:5173/@fs/Users/me/Sites/harbour/.siteorigin/cache/dev/src/lib/siteorigin/generated/theme-hero.svelte:8:5`;
    expect(errorComponent([stack], components, DIR)).toBe('theme.hero');
    // Reached through a linked folder: the served copy is still the editor's own.
    expect(errorComponent([`Hero@http://h/@fs/private/var/x/harbour/.siteorigin/cache/dev/src/lib/siteorigin/generated/theme-hero.svelte:8:5`], components, '/var/x/harbour')).toBe('theme.hero');
  });

  it('names a component shown on its own in Component Studio', () => {
    expect(errorComponent(['at http://h/.siteorigin/cache/dev/isolated/k1/src/lib/components/PricingCard.svelte:2:1'], components, DIR)).toBe('project.pricing-card');
  });

  it('takes the frame nearest the throw', () => {
    const stack = `Error: boom
    at http://h/src/lib/siteorigin/generated/theme-hero-alt.svelte:3:1
    at http://h/src/lib/siteorigin/generated/theme-hero.svelte:9:1`;
    expect(errorComponent([stack], components, DIR)).toBe('theme.hero-alt');
  });

  it('reads a build error by its absolute path, on macOS and Windows, and a path from the project folder', () => {
    expect(errorComponent([`${DIR}/src/lib/siteorigin/generated/theme-hero.svelte`], components, DIR)).toBe('theme.hero');
    expect(errorComponent([undefined, 'C:\\Sites\\harbour\\src\\lib\\components\\PricingCard.svelte'], components, 'C:\\Sites\\harbour')).toBe('project.pricing-card');
    expect(errorComponent(['Unexpected token in src/lib/components/PricingCard.svelte:3:4'], components, DIR)).toBe('project.pricing-card');
    // A build error's file, taken whole, in a folder with a space.
    expect(errorComponent(['/Users/me/Harbour Lane/src/lib/components/PricingCard.svelte:3:4'], components, '/Users/me/Harbour Lane')).toBe('project.pricing-card');
  });

  it('never takes a file whose path only ends like a component’s', () => {
    expect(errorComponent(['at http://h/src/lib/siteorigin/generated/x-theme-hero.svelte:1:1'], components, DIR)).toBeNull();
    expect(errorComponent(['at http://h/src/lib/vendor/src/lib/components/PricingCard.svelte:1:1'], components, DIR)).toBeNull();
    expect(errorComponent(['at http://h/node_modules/ui/src/lib/components/PricingCard.svelte:1:1'], components, DIR)).toBeNull();
    expect(errorComponent(['/Users/me/Sites/other/src/lib/components/PricingCard.svelte'], components, DIR)).toBeNull();
    expect(errorComponent(['at http://h/@fs/Users/me/lib/src/lib/components/PricingCard.svelte:1:1'], components, DIR)).toBeNull();
  });

  it('names nothing for the runtime, a page, or a message without a file', () => {
    expect(errorComponent(['at http://h/src/lib/siteorigin/runtime/Link.svelte:1:1\n at http://h/src/routes/+page.svelte:2:2'], components, DIR)).toBeNull();
    expect(errorComponent(['Cannot read properties of undefined'], components, DIR)).toBeNull();
    expect(errorComponent([], {}, DIR)).toBeNull();
  });
});

const history = (entries: Array<[string, boolean, number?]>): HistoryInfo => ({
  canUndo: true,
  canRedo: false,
  entries: entries.map(([id, applied, revision]) => ({ id, label: `Edit ${id}`, source: 'user', time: '', revision: revision ?? 1, applied }))
});

describe('revertStep', () => {
  const steps = (entries: Array<[string, boolean, number?]>) => appliedSteps(history(entries));

  it('offers the one change made since the page worked, when it was in place at the error', () => {
    const after = history([['a', true, 1], ['b', true, 2]]);
    expect(revertStep(after, steps([['a', true, 1]]), appliedSteps(after))).toEqual({ id: 'b', label: 'Edit b' });
  });

  it('offers nothing when the page was never seen working (an error there on open)', () => {
    const h = history([['a', true, 1]]);
    expect(revertStep(h, null, appliedSteps(h))).toBeNull();
  });

  it('offers nothing when no change came since the page last worked', () => {
    const h = history([['a', true, 1], ['b', true, 2]]);
    expect(revertStep(h, appliedSteps(h), appliedSteps(h))).toBeNull();
  });

  it('offers nothing when two changes came since, or one was swapped for another', () => {
    const three = history([['a', true, 1], ['b', true, 2], ['c', true, 3]]);
    expect(revertStep(three, steps([['a', true, 1]]), appliedSteps(three))).toBeNull();
    // Undone and replaced: the page lost one change and gained another.
    const swapped = history([['a', true, 1], ['c', true, 4]]);
    expect(revertStep(swapped, steps([['a', true, 1], ['b', true, 2]]), appliedSteps(swapped))).toBeNull();
    // As many steps as before, but not the same ones.
    const other = history([['x', true, 1], ['c', true, 4]]);
    expect(revertStep(other, steps([['a', true, 1]]), appliedSteps(other))).toBeNull();
  });

  it('offers nothing after an Undo, and the redone change after a Redo that came before the error', () => {
    const both = history([['a', true, 1], ['b', true, 2]]);
    const undone = history([['a', true, 1], ['b', false, 2]]);
    expect(revertStep(undone, appliedSteps(both), appliedSteps(undone))).toBeNull();
    expect(revertStep(both, appliedSteps(undone), appliedSteps(both))?.id).toBe('b');
  });

  it('offers nothing for a change that came after the error: a Redo, an edit, or the AI’s step recorded late', () => {
    const both = history([['a', true, 1], ['b', true, 2]]);
    const atError = steps([['a', true, 1], ['b', false, 2]]);
    expect(revertStep(both, steps([['a', true, 1]]), atError)).toBeNull();
  });

  it('offers a step that later edits joined after the page last worked, until it is joined after the error', () => {
    const typing = steps([['a', true, 1], ['b', true, 2]]);
    const more = history([['a', true, 1], ['b', true, 5]]);
    expect(revertStep(more, typing, appliedSteps(more))).toMatchObject({ id: 'b', label: 'Edit b' });
    expect(revertStep(history([['a', true, 1], ['b', true, 6]]), typing, appliedSteps(more))).toBeNull();
  });

  it('reads steps History has let go of since as no change', () => {
    // History keeps so many steps: the change that broke the page pushed the oldest out.
    const full = history([['b', true, 2], ['c', true, 3]]);
    expect(revertStep(full, steps([['a', true, 1], ['b', true, 2]]), appliedSteps(full))?.id).toBe('c');
  });

  it('offers nothing with an empty history', () => {
    expect(revertStep(history([]), [], [])).toBeNull();
  });
});

describe('projectPath', () => {
  it('reads an address, a /@fs address and an absolute path from the project folder', () => {
    expect(projectPath('http://127.0.0.1:5173/src/lib/x.svelte', DIR)).toBe('src/lib/x.svelte');
    expect(projectPath(`http://h/@fs${DIR}/src/lib/x.svelte`, DIR)).toBe('src/lib/x.svelte');
    expect(projectPath(`${DIR}/.siteorigin/cache/dev/src/lib/x.svelte`, DIR)).toBe('src/lib/x.svelte');
    expect(projectPath('src/lib/x.svelte', DIR)).toBe('src/lib/x.svelte');
  });

  it('reads an escaped address and a folder with spaces, and a Windows drive in either case', () => {
    expect(projectPath('http://h/@fs/Users/me/Harbour%20Lane/src/lib/x.svelte', '/Users/me/Harbour Lane')).toBe('src/lib/x.svelte');
    expect(projectPath('c:/Sites/Harbour/src/lib/x.svelte', 'C:\\Sites\\Harbour')).toBe('src/lib/x.svelte');
  });

  it('refuses a package’s file and a file outside the project', () => {
    expect(projectPath('/other/node_modules/pkg/.siteorigin/cache/dev/src/lib/x.svelte', DIR)).toBeNull();
    expect(projectPath('http://h/node_modules/ui/src/lib/x.svelte', DIR)).toBeNull();
    expect(projectPath('http://h/%6Eode_modules/ui/src/lib/x.svelte', DIR)).toBeNull();
    expect(projectPath('/Users/me/Sites/other/src/lib/x.svelte', DIR)).toBeNull();
  });
});
