/**
 * Dialogs and drawers in managed designs (#378): a plain container a yes/no UI state shows, marked to show over the
 * page (`overlay`), where it can work; the operation that marks it; the native <dialog> the generator writes, its
 * buttons, name and script, in the site and in the editor's variant; the stylesheet that hides, holds and never prints
 * it; and the format step that keeps an older editor from dropping it.
 */
import { describe, expect, it } from 'vitest';
import { compile } from 'svelte/compiler';
import type { ComponentDefinition, ElementNode, InstanceNode, ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { defFile, generateProject, keptPanels } from '@generator/index';
import { UTIL_JS } from '@generator/runtime-files';
import { FOUNDATION_BASE_CSS } from '@catalogue/foundation/base.css';
import { P, eq, prop, uiState, type ComponentSpec } from '@catalogue/dsl';
import { FOUNDATION } from '@catalogue/foundation/pack';
import { MIGRATIONS } from '@shared/migrations';
import { executeTool } from '@agent/tools';

const { managed } = FOUNDATION;
const NONE = { type: 'none' as const, target: '' };
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];
const owner = (def: ComponentDefinition) => ({ kind: 'component' as const, id: def.id });
const errors = (s: ProjectState) => validateState(s).filter(blocksSaving);
const overlayErrors = (s: ProjectState) => errors(s).filter((d) => d.code === 'OVERLAY_INVALID');

function addDef(s: ProjectState, spec: Omit<ComponentSpec, 'category' | 'tags' | 'icon' | 'description'>): ComponentDefinition {
  const def = { ...managed({ category: 'content', tags: [], icon: 'sparkles', description: '', ...spec }), owner: 'project' as const };
  s.components[def.id] = def;
  return def;
}

function place(s: ProjectState, def: ComponentDefinition): InstanceNode {
  const node = makeInstance(def, {});
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return node;
}

/**
 * A booking design: Book toggles the booking state, Reserve sets it on, Cancel (outside) sets it off, and the dialog
 * shown while it is on holds a heading, a line, Close and a tab list of its own over a choice.
 */
function bookingDef(s: ProjectState, dialog: Partial<ElementNode> = {}) {
  return addDef(s, {
    componentId: 'test.booking',
    name: 'Booking',
    properties: { title: P.str('Title', 'Book a consultation') },
    parts: {},
    state: {
      booking: { type: 'boolean', label: 'Booking form', initial: false },
      size: { type: 'enum', label: 'Sizes', options: [{ value: 'men', label: 'Men' }, { value: 'women', label: 'Women' }], initial: 'men' }
    },
    build: (b) =>
      b.el('root', 'section', {}, [
        b.link('book', NONE, 'Book', 'primary', { stateAction: { state: 'booking', op: 'toggle' } }),
        b.link('reserve', NONE, 'Reserve', 'secondary', { stateAction: { state: 'booking', op: 'set', value: true } }),
        b.link('cancel', NONE, 'Cancel', 'text', { stateAction: { state: 'booking', op: 'set', value: false } }),
        b.el('dialog', 'div', { when: uiState('booking'), overlay: 'dialog', ...(dialog as object) }, [
          b.text('title', 'h2', prop('title')),
          b.text('body', 'p', 'Tell us about your project.'),
          b.link('close', NONE, 'Close', 'secondary', { stateAction: { state: 'booking', op: 'set', value: false } }),
          b.el('tabs', 'div', {}, [
            b.link('tab-men', NONE, 'Men', 'secondary', { stateAction: { state: 'size', op: 'set', value: 'men' } }),
            b.link('tab-women', NONE, 'Women', 'secondary', { stateAction: { state: 'size', op: 'set', value: 'women' } })
          ]),
          b.el('men', 'div', { when: eq(uiState('size'), 'men') }, [b.text('men-text', 'p', 'Men’s sizes')]),
          b.el('women', 'div', { when: eq(uiState('size'), 'women') }, [b.text('women-text', 'p', 'Women’s sizes')])
        ])
      ])
  });
}

/** Every compiler warning, accessibility ones included, for a design's files in the site and the editor's variant. */
function compileWarnings(s: ProjectState, def: ComponentDefinition): string[] {
  const out: string[] = [];
  for (const instrument of [false, true]) {
    const source = generateProject(s, { instrument }).get(defFile(def))!;
    for (const generate of ['server', 'client'] as const) out.push(...compile(source, { filename: defFile(def), generate, runes: true }).warnings.map((w) => `${instrument ? 'editor' : 'site'} (${generate}): ${w.code}`));
  }
  return out;
}

const tree = (def: ComponentDefinition) => def.tree!;
const node = (def: ComponentDefinition, id: string) => tree(def).nodes[id] as ElementNode;

describe('where a dialog or drawer can be', () => {
  it('works as a plain div a yes/no state of its design shows, in every polarity, and the site generates it', () => {
    const open = 'so_state_booking';
    const guards: Array<[Partial<ElementNode>, string]> = [
      [{ when: uiState('booking') }, open],
      [{ when: eq(uiState('booking'), true) }, open],
      [{ when: { ref: uiState('booking'), ne: true } }, `!${open}`],
      [{ unless: uiState('booking') }, `!${open}`],
      [{ unless: eq(uiState('booking'), false) }, open],
      [{ unless: { ref: uiState('booking'), ne: false } }, `!${open}`]
    ];
    for (const [guard, opens] of guards) {
      const s = fresh();
      const def = bookingDef(s);
      const d = node(def, 'dialog');
      delete d.when;
      Object.assign(d, guard);
      place(s, def);
      expect(errors(s)).toEqual([]);
      const out = generateProject(s).get(defFile(def))!;
      expect(out).toContain(`$effect(() => overlayOpen(so_dialog_1, ${opens}));`);
      // Every way of closing it sets the state to the value that hides it.
      const closes = `${open} = ${opens === open ? 'false' : 'true'};`;
      expect(out).toContain(`event.preventDefault();\n\t\t\t${closes}`);
      expect(out).toContain(`if (event.currentTarget !== so_dialog_1 || event.currentTarget.open) return;\n\t\t\t${closes}`);
      expect(out).toContain(`if (away) ${closes}`);
    }
  });

  const broken: Array<[string, (def: ComponentDefinition) => void, RegExp]> = [
    ['a choice state', (def) => (node(def, 'dialog').when = eq(uiState('size'), 'men')), /no yes\/no UI state of the component opens/],
    ['no condition', (def) => delete node(def, 'dialog').when, /no yes\/no UI state of the component opens/],
    ['two conditions', (def) => (node(def, 'dialog').unless = { $prop: 'title' }), /no yes\/no UI state of the component opens/],
    ['the top element', (def) => Object.assign(node(def, 'root'), { overlay: 'dialog', when: uiState('booking') }), /the component’s top element/],
    ['a tag of its own', (def) => (node(def, 'dialog').tag = 'section'), /plain div container/],
    ['an anchor', (def) => (node(def, 'dialog').anchor = 'booking'), /anchor of its own/],
    ['an entrance', (def) => (node(def, 'dialog').appear = 'fade'), /takes no entrance/],
    ['hiding when empty', (def) => (node(def, 'dialog').collapseEmpty = true), /cannot hide when everything inside it is hidden/],
    ['a link of its own', (def) => (node(def, 'dialog').link = { type: 'url', target: 'https://example.com' }), /links somewhere or opens something/],
    ['a mode it does not have', (def) => ((node(def, 'dialog') as { overlay: unknown }).overlay = 'popover'), /"popover", which is not "dialog", "drawer-start", "drawer-end", "drawer-bottom"/],
    [
      'content shown on a condition',
      (def) => {
        tree(def).nodes.wrap = { id: 'wrap', kind: 'element', tag: 'div', children: ['dialog'], when: { $prop: 'title' } } as ElementNode;
        (tree(def).nodes.root as ElementNode).children = (tree(def).nodes.root as ElementNode).children.map((c) => (c === 'dialog' ? 'wrap' : c));
      },
      /inside content shown only on a condition/
    ],
    [
      'a second dialog on the same state',
      (def) => {
        tree(def).nodes.again = { id: 'again', kind: 'element', tag: 'div', children: [], when: uiState('booking'), overlay: 'drawer-end' } as ElementNode;
        (tree(def).nodes.root as ElementNode).children.push('again');
      },
      /one of two dialogs or drawers opened by the UI state "booking"/
    ]
  ];
  it.each(broken)('is refused with %s, and renders as an ordinary container with its condition', (_, damage, words) => {
    const s = fresh();
    const def = bookingDef(s);
    damage(def);
    place(s, def);
    const found = overlayErrors(s);
    expect(found.length).toBeGreaterThan(0);
    expect(found[0].message).toMatch(words);
    const out = generateProject(s).get(defFile(def))!;
    expect(out).not.toContain('<dialog');
    expect(out).not.toContain('so-overlay');
  });

  it('keeps one marked but refused an ordinary container in the page only while its condition holds', () => {
    for (const damage of [(d: ElementNode) => (d.tag = 'section'), (d: ElementNode) => ((d as { overlay: unknown }).overlay = 'popover')]) {
      const s = fresh();
      const def = bookingDef(s);
      damage(node(def, 'dialog'));
      place(s, def);
      const out = generateProject(s).get(defFile(def))!;
      // Not a disclosure kept in the page (which would print it): a plain block shown by its condition.
      expect(out).toMatch(/\{#if has\(so_state_booking\)\}\n\t\t<(section|div) class=\{\["so-foundation-test-booking__dialog"\]\}>/);
      expect(out).not.toContain('aria-expanded');
    }
  });

  it('refuses a category filter held by the dialog itself, whose pills would stay on the page', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.filtered',
      name: 'Filtered',
      properties: { items: P.list('Projects', 'Project', { title: P.str('Title', 'Project'), category: P.str('Category', '') }, [{ title: 'A', category: 'One' }, { title: 'B', category: 'Two' }]) },
      parts: {},
      state: { open: { type: 'boolean', label: 'Projects', initial: false } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.link('show', NONE, 'Projects', 'primary', { stateAction: { state: 'open', op: 'toggle' } }),
          b.el('dialog', 'div', { when: uiState('open'), overlay: 'dialog' }, [b.repeat('cards', 'items', [b.el('card', 'div', {}, [b.text('title', 'h3', { $item: 'title' })])], { filter: { field: 'category' } })])
        ])
    });
    place(s, def);
    expect(validateState(s).filter((d) => d.code === 'FILTER_INVALID').map((d) => d.message)).toEqual([expect.stringMatching(/held by a dialog or drawer itself/)]);
    const out = generateProject(s).get(defFile(def))!;
    expect(out).toContain('<dialog');
    expect(out).not.toContain('so-filter');
  });

  it('is refused on a page, which has no UI state to open it', () => {
    const s = fresh();
    const page = home(s);
    page.nodes.box = { id: 'box', kind: 'element', tag: 'div', children: [], overlay: 'dialog' } as ElementNode;
    page.rootIds.push('box');
    expect(overlayErrors(s).map((d) => d.nodeId)).toEqual(['box']);
  });
});

describe('the operation that makes a container a dialog or drawer', () => {
  it('marks and clears it, its state, condition and buttons set in the same batch', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.plain',
      name: 'Plain',
      properties: {},
      parts: {},
      build: (b) => b.el('root', 'section', {}, [b.link('open', NONE, 'Open', 'primary'), b.el('panel', 'div', {}, [b.text('words', 'p', 'Inside')])])
    });
    place(s, def);
    const o = owner(def);
    const batch: EditOperation[] = [
      { type: 'component.setState', definitionId: def.id, state: 'open', schema: { type: 'boolean', label: 'Size guide' } },
      { type: 'node.setBinding', owner: o, nodeId: 'panel', field: 'when', binding: { $state: 'open' } },
      { type: 'node.setStateAction', owner: o, nodeId: 'open', action: { state: 'open', op: 'toggle' } },
      { type: 'node.setContent', owner: o, nodeId: 'panel', field: 'overlay', value: 'drawer-bottom' }
    ];
    const next = applyOperations(s, batch).state;
    expect(node(next.components[def.id], 'panel').overlay).toBe('drawer-bottom');
    expect(introducedDiagnostics(errors(s), errors(next))).toEqual([]);
    expect(generateProject(next).get(defFile(next.components[def.id]))).toContain('so-overlay--drawer-bottom');
    const cleared = applyOperations(next, [{ type: 'node.setContent', owner: o, nodeId: 'panel', field: 'overlay', value: null }]).state;
    expect(Object.hasOwn(node(cleared.components[def.id], 'panel'), 'overlay')).toBe(false);
    // Marked without a state to open it, the batch leaves a new problem behind, which the session refuses.
    const unopened = applyOperations(s, [batch[3]]).state;
    expect(introducedDiagnostics(errors(s), errors(unopened)).map((d) => d.code)).toEqual(['OVERLAY_INVALID']);
  });

  it('refuses a mode it does not have, text, and a page’s own container', () => {
    const s = fresh();
    const def = bookingDef(s);
    const o = owner(def);
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: o, nodeId: 'dialog', field: 'overlay', value: 'modal' }])).toThrow(/A dialog or drawer is dialog, drawer-start, drawer-end, drawer-bottom/);
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: o, nodeId: 'body', field: 'overlay', value: 'dialog' }])).toThrow(/Only a container in a component’s design/);
    home(s).nodes.box = { id: 'box', kind: 'element', tag: 'div', children: [] } as ElementNode;
    home(s).rootIds.push('box');
    expect(() => applyOperations(s, [{ type: 'node.setContent', owner: { kind: 'page', id: home(s).id }, nodeId: 'box', field: 'overlay', value: 'dialog' }])).toThrow(/Only a container in a component’s design/);
  });

  it('is the assistant’s to set, with the rest of UI state, now that the site opens it (#377)', async () => {
    const s = fresh();
    const def = bookingDef(s);
    let state = s;
    const host = {
      state: () => state,
      revision: () => 1,
      diagnostics: () => validateState(state),
      apply: async (ops: EditOperation[]) => ((state = applyOperations(state, ops).state), { ok: true, revision: 2, results: [] })
    } as unknown as Parameters<typeof executeTool>[2];
    const out = await executeTool('apply_operations', JSON.stringify({ expectedRevision: 1, operations: [{ type: 'node.setContent', owner: owner(def), nodeId: 'dialog', field: 'overlay', value: 'drawer-end' }] }), host, 'c1');
    expect(out.ok, JSON.stringify(out.content)).toBe(true);
    expect((state.components[def.id].tree!.nodes.dialog as { overlay?: string }).overlay).toBe('drawer-end');
  });
});

describe('the generated dialog', () => {
  it('compiles without a warning for the server and the browser, in the site and the editor’s variant', () => {
    const s = fresh();
    const def = bookingDef(s);
    place(s, def);
    expect(generateProject(s).get(defFile(def))).toContain('<dialog');
    expect(compileWarnings(s, def)).toEqual([]);
  });

  it('is a closed <dialog> its buttons open, named by its heading, with what is inside rendered once', () => {
    const s = fresh();
    const def = bookingDef(s);
    place(s, def);
    const out = generateProject(s).get(defFile(def))!;
    // Book (a toggle) and Reserve (sets it on) open it and say so; Cancel, outside, and Close, inside, are commands.
    const button = (label: string) => out.slice(out.lastIndexOf('<SoLink', out.indexOf(`{"${label}"}</SoLink>`)), out.indexOf(`{"${label}"}</SoLink>`));
    for (const label of ['Book', 'Reserve']) {
      expect(button(label)).toContain('aria-haspopup="dialog" aria-expanded={so_state_booking} aria-controls={`${uid}.dialog.dialog`}');
      expect(button(label)).toContain('so_opener_1 = event.currentTarget;');
    }
    expect(out).toContain('so_state_booking = false;\n\t\t\tso_opener_1 = overlayClosed(so_opener_1);');
    for (const label of ['Cancel', 'Close']) expect(button(label)).not.toMatch(/aria-(haspopup|pressed|expanded)/);
    // Named by its heading while the placement gives it words, else by its state's label.
    expect(out).toMatch(/<dialog\s+bind:this=\{so_dialog_1\}\s+id=\{`\$\{uid\}\.dialog\.dialog`\}\s+class=\{\["so-foundation-test-booking__dialog", "so-overlay", "so-overlay--dialog"\]\} aria-label=\{has\(title\) \? undefined : "Booking form"\} aria-labelledby=\{has\(title\) \? `\$\{uid\}-title` : undefined\}/);
    expect(out).toContain('<h2 class={["so-foundation-test-booking__title"]} id={`${uid}-title`}>');
    expect(out).not.toMatch(/<dialog[^>]*\sopen/);
    expect(out).toContain('$effect(() => overlayOpen(so_dialog_1, so_state_booking));');
    expect(out).toContain('beforeNavigate(() => {\n\t\tso_opener_1 = null;\n\t\tso_state_booking = false;\n\t});');
    // Its tabs work inside it: it is always in the page, once.
    expect(out).toContain('role="tablist"');
    expect(out.match(/role="tabpanel"/g)).toHaveLength(2);
    // The checks count what is inside as markup the page ships.
    expect([...keptPanels(s, def)].sort()).toEqual(['dialog', 'men', 'women'].sort());
  });

  it('closes to the other value for a dialog shown while a state is off', () => {
    const s = fresh();
    const def = bookingDef(s);
    const d = node(def, 'dialog');
    delete d.when;
    d.unless = uiState('booking');
    place(s, def);
    const out = generateProject(s).get(defFile(def))!;
    expect(out).toContain('$effect(() => overlayOpen(so_dialog_1, !so_state_booking));');
    expect(out).toContain('if (away) so_state_booking = true;');
    // Turning the state on closes it, so Reserve is a command, and Cancel (turning it off) opens it.
    const tag = (label: string) => out.slice(out.lastIndexOf('<SoLink', out.indexOf(`{"${label}"}</SoLink>`)), out.indexOf(`{"${label}"}</SoLink>`));
    expect(tag('Reserve')).not.toContain('aria-haspopup');
    expect(tag('Cancel')).toContain('aria-haspopup="dialog" aria-expanded={!so_state_booking}');
  });

  it('is named by its heading when its words are fixed, and by its own name before the heading', () => {
    const fixed = fresh();
    const def = bookingDef(fixed);
    (tree(def).nodes.title as { text: unknown }).text = 'Book a consultation';
    place(fixed, def);
    expect(generateProject(fixed).get(defFile(def))).toContain('"so-overlay--dialog"]} aria-labelledby={`${uid}-title`}\n');
    // A heading left without words names nothing: the state's label does.
    (tree(def).nodes.title as { text: unknown }).text = ' ';
    expect(generateProject(fixed).get(defFile(def))).toContain('"so-overlay--dialog"]} aria-label={"Booking form"}\n');
    const both = fresh();
    const other = bookingDef(both, { ariaLabel: { $prop: 'title' } });
    place(both, other);
    expect(generateProject(both).get(defFile(other))).toContain('aria-label={has(title) ? title : has(title) ? undefined : "Booking form"} aria-labelledby={!has(title) && has(title) ? `${uid}-title` : undefined}');
  });

  it('is named by its own name, falling back to its state’s label while a bound one is blank', () => {
    const named = fresh();
    const def = bookingDef(named, { ariaLabel: 'Booking' });
    place(named, def);
    expect(generateProject(named).get(defFile(def))).toContain('class={["so-foundation-test-booking__dialog", "so-overlay", "so-overlay--dialog"]} aria-label={"Booking"}\n');
    const bound = fresh();
    const other = bookingDef(bound, { ariaLabel: { $prop: 'title' } });
    tree(other).nodes.title = { ...tree(other).nodes.title, tag: 'p' } as never;
    place(bound, other);
    expect(generateProject(bound).get(defFile(other))).toContain('aria-label={has(title) ? title : "Booking form"}');
  });

  it('opens in the editor’s variant only while previewed, and in Edit renders in place beside the editor’s button', () => {
    const s = fresh();
    const def = bookingDef(s, { overlay: 'drawer-start' });
    place(s, def);
    const out = generateProject(s, { instrument: true }).get(defFile(def))!;
    expect(out).toContain(`const sync = () => (so_previewing = html.getAttribute('data-so-bridge') === 'preview');`);
    expect(out).toContain('$effect(() => overlayOpen(so_dialog_1, so_previewing && so_state_booking));');
    expect(out).toMatch(/\{#if so_editing\}\n\t\t<button type="button" class="so-overlay-peek" data-so-editor-only="" data-so-overlay-peek="" aria-controls=\{`\$\{uid\}\.dialog\.dialog`\} aria-expanded="false">\{"Drawer: Booking form"\}<\/button>\n\t\t<div id=\{`\$\{uid\}\.dialog\.dialog`\} class=\{[^}]*\} data-so-overlay="drawer-start" data-so-ctx=\{__so\} data-so-node="dialog">\n\t\t\t\{@render so_overlay_1\(\)\}/);
    expect(out.match(/\{@render so_overlay_1\(\)\}/g)).toHaveLength(2);
    // The site's own copy has none of the editor's.
    expect(generateProject(s).get(defFile(def))).not.toMatch(/so_editing|so_previewing|data-so-/);
  });
});

describe('the checks', () => {
  it('count content a placement puts in a slot inside a closed dialog as hidden with it, so a jump within it is fine', () => {
    const s = fresh();
    const def = addDef(s, {
      componentId: 'test.terms',
      name: 'Terms',
      properties: {},
      parts: {},
      slots: { extra: { label: 'Extra' } },
      state: { open: { type: 'boolean', label: 'Terms', initial: false } },
      build: (b) =>
        b.el('root', 'section', {}, [
          b.link('show', NONE, 'Terms', 'secondary', { stateAction: { state: 'open', op: 'toggle' } }),
          b.el('dialog', 'div', { when: uiState('open'), overlay: 'dialog' }, [b.text('terms', 'p', 'The terms', { anchor: 'terms' }), b.slot('extra', 'extra')])
        ])
    });
    const placed = place(s, def);
    home(s).nodes.jump = { id: 'jump', kind: 'link', link: { type: 'anchor', target: 'terms' }, label: 'Read the terms', appearance: 'link' } as never;
    placed.slots = { extra: ['jump'] };
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING')).toEqual([]);
    // A jump to it from outside the dialog lands on nothing a visitor sees.
    home(s).nodes.outside = { id: 'outside', kind: 'link', link: { type: 'anchor', target: 'terms' }, label: 'Terms', appearance: 'link' } as never;
    home(s).rootIds.push('outside');
    expect(validateState(s).filter((d) => d.code === 'LINK_SECTION_MISSING').map((d) => d.nodeId)).toEqual(['outside']);
  });
});

describe('the stylesheets', () => {
  it('hide a closed dialog whatever its display, hold the page behind an open one, place drawers and print none', () => {
    const s = fresh();
    expect(generateProject(s).get('src/lib/siteorigin/styles/components.css')).not.toContain('so-overlay');
    const def = bookingDef(s, { styles: { base: { width: '40rem' } } });
    place(s, def);
    const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
    expect(css).toContain('@media not print {\n\tdialog.so-overlay:not([open]):not(#so-print) { display: none !important; }\n\thtml:has(dialog.so-overlay) { scrollbar-gutter: stable; }\n\thtml:has(dialog.so-overlay:modal) { overflow: hidden; }\n}');
    expect(css).toContain('overscroll-behavior: contain;');
    expect(css).toContain(':where(dialog.so-overlay--drawer-start:modal) { margin-inline: 0 auto; }');
    expect(css).toContain(':where(dialog.so-overlay--drawer-end:modal) { margin-inline: auto 0; }');
    expect(css).toContain(':where(dialog.so-overlay--drawer-bottom:modal) { width: 100%; max-width: none; max-height: 85vh; max-height: 85dvh; margin: auto 0 0; }');
    expect(css).toContain('@media print {\n\tdialog.so-overlay:not(#so-print), dialog.so-overlay:not(#so-print)::backdrop { display: none !important; }\n}');
    // The rules come before the designs' own, at no weight, so a design's sizes for its dialog win.
    expect(css).toMatch(/\.so-foundation-test-booking__dialog \{\n\twidth: 40rem;/);
    expect(css.indexOf('so-overlay')).toBeLessThan(css.indexOf('.so-foundation-test-booking__dialog'));
    expect(FOUNDATION_BASE_CSS).toContain('.so-overlay::backdrop');
    expect(UTIL_JS).toContain('export function overlayOpen(dialog, open)');
    // The surface takes the page's own ink, in a dark section too, and a design's radius for a drawer wins.
    expect(FOUNDATION_BASE_CSS).toMatch(/\.so-video-section, \.so-overlay\n\) \{ --so-surface-ink: initial; --so-surface-ink-text: initial; --so-surface-ink-hover: initial; \}/);
    expect(FOUNDATION_BASE_CSS).toContain('.so-overlay:where(.so-overlay--drawer-start, .so-overlay--drawer-end, .so-overlay--drawer-bottom) { border-radius: 0; }');
  });
});

describe('the document format', () => {
  it('marks it with a version-only step, so an older editor opens a project with dialogs read-only', () => {
    const step = MIGRATIONS.find((m) => m.id === 'managed-overlays')!;
    expect(step).toBeDefined();
    expect(MIGRATIONS.indexOf(step) + 2).toBe(17);
    expect(MIGRATIONS.indexOf(step)).toBe(MIGRATIONS.findIndex((m) => m.id === 'color-schemes') + 1);
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
    const s = fresh();
    bookingDef(s);
    const out = structuredClone(s);
    step.migrate(out as never, () => true);
    expect(out).toEqual(s);
  });
});
