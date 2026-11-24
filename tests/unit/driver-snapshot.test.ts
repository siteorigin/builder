// The pure half of the test driver's UI observations (tests/driver/snapshot.ts, issue #492): redaction, shaping,
// bounding, finding, context and refs, on Playwright-shaped trees, plus the operations' argument checks.
import { describe, expect, it } from 'vitest';
import { parseLocateArgs, parseSnapshotArgs, semanticSelector } from '../driver/observe.ts';
import { DriverError } from '../driver/protocol.ts';
import {
  REDACTED,
  RefRegistry,
  choose,
  describe as describeNode,
  dialogFrom,
  find,
  findByPwRef,
  focusFrom,
  looksLikeRef,
  modeFrom,
  redact,
  regionNodes,
  render,
  rootsLeft,
  scrubDeep,
  selectionToolbar,
  shape,
  valueRefs,
  walk
} from '../driver/snapshot.ts';
import type { ElementFacts, RawNode, Shaped } from '../driver/snapshot.ts';

const none = { secretRefs: new Set<string>(), unknownRefs: new Set<string>(), secrets: [] as string[] };
const json = (v: unknown) => JSON.stringify(v);
const facts = (f: Partial<ElementFacts> = {}): ElementFacts => ({ secret: false, blocked: false, clipped: false, semantic: null, ...f });

function settingsTree(): RawNode[] {
  return [
    {
      role: 'dialog',
      name: 'Settings',
      ref: 'e1',
      children: [
        // The field's value comes as its text and as fragments under it.
        { role: 'textbox', name: 'API key', ref: 'e2', text: 'sk-SECRET-123456', children: ['sk-SECRET-123456', { role: 'text', text: 'sk-SECRET-123456' }, { role: 'button', name: 'Show', ref: 'e9' }] },
        { role: 'status', ref: 'e3', text: 'Saved sk-SECRET-123456 for later' },
        { role: 'textbox', name: 'Title', ref: 'e4', text: 'Home' },
        { role: 'generic', ref: 'e5', children: ['Typed sk-SECRET-123456'] },
        { role: 'button', name: 'Use sk-SECRET-123456', ref: 'e6' },
        { role: 'link', name: 'Docs', ref: 'e7', url: 'https://x.test/?k=sk-SECRET-123456' },
        { role: 'textbox', name: 'Again', ref: 'e8', placeholder: 'was sk-SECRET-123456' }
      ]
    }
  ];
}

describe('redaction', () => {
  it('finds every field that holds a value, to classify it', () => {
    expect(valueRefs(settingsTree())).toEqual(['e2', 'e4']);
    expect(valueRefs([{ role: 'spinbutton', ref: 's1', children: ['1280'] }, { role: 'textbox', ref: 's2' }, { role: 'slider', ref: 's3', text: '4' }, { role: 'searchbox', ref: 's4', children: [{ role: 'text', text: 'q' }] }])).toEqual(['s1', 's3', 's4']);
  });

  it('removes a secret field’s value, and every echo of it, even one the page reads missed', () => {
    // The page reads saw no secret (it was typed between them); what the field held is what is scrubbed.
    const out = redact(settingsTree(), { ...none, secretRefs: new Set(['e2']) });
    expect(json(out.nodes)).not.toContain('SECRET');
    expect(out.secrets).toContain('sk-SECRET-123456');
    expect(out.echoes).toBe(5);
    const field = (out.nodes[0] as RawNode).children![0] as RawNode;
    // The raw field keeps its other children but none of the value.
    expect(field).toMatchObject({ redacted: true, children: [{ role: 'button', name: 'Show' }] });
    expect(field.text).toBeUndefined();
    const [dialog] = shape(out.nodes, 'editor');
    const [key, status, title, typed, use, docs, again] = dialog.children;
    expect(key).toMatchObject({ role: 'textbox', name: 'API key', redacted: true });
    expect(key.value).toBeUndefined();
    expect(status.text).toBe(`Saved ${REDACTED} for later`);
    expect(title.value).toBe('Home');
    // The unnamed wrapper is folded away in the editor: its text stands in its place.
    expect(typed).toMatchObject({ role: 'text', text: `Typed ${REDACTED}` });
    expect(use.name).toBe(`Use ${REDACTED}`);
    expect(docs.url).toBe(`https://x.test/?k=${REDACTED}`);
    expect(again.placeholder).toBe(`was ${REDACTED}`);
  });

  it('treats a field it could not classify, or one with no ref, as a secret', () => {
    const out = redact(
      [
        { role: 'textbox', name: 'A', ref: 'a', text: 'x1-unread', children: ['x1-unread'] },
        { role: 'searchbox', name: 'B', text: 'x2-noref' },
        { role: 'textbox', name: 'C', ref: 'c', text: 'kept' },
        { role: 'paragraph', ref: 'p', text: 'echo x1-unread and x2-noref' }
      ],
      { ...none, unknownRefs: new Set(['a']) }
    );
    expect((out.nodes[0] as RawNode).children).toEqual([]);
    const shaped = shape(out.nodes, 'editor');
    expect(shaped.map((n) => [n.name, n.value, n.redacted])).toEqual([
      ['A', undefined, true],
      ['B', undefined, true],
      ['C', 'kept', undefined],
      [undefined, undefined, undefined]
    ]);
    expect(shaped[3].text).toBe(`echo ${REDACTED} and ${REDACTED}`);
  });

  it('scrubs secrets read from the page wherever they appear, from two characters; one only as a whole value', () => {
    const out = redact(
      [
        { role: 'paragraph', ref: 'p', text: 'the hunter2 key', name: 'see hunter2' },
        { role: 'paragraph', ref: 'q', text: 'ab and xaby' },
        { role: 'paragraph', ref: 'r', text: 'z' },
        { role: 'paragraph', ref: 's', text: 'zebra' }
      ],
      { ...none, secrets: ['hunter2', 'ab', 'z'] }
    );
    expect(out.nodes.map((n) => (typeof n === 'string' ? n : [n.name, n.text]))).toEqual([
      [`see ${REDACTED}`, `the ${REDACTED} key`],
      [undefined, `${REDACTED} and x${REDACTED}y`],
      [undefined, REDACTED],
      [undefined, 'zebra']
    ]);
  });

  it('scrubs each piece a field held, longest secret first, and counts every echo', () => {
    const out = redact(
      [
        { role: 'textbox', name: 'Key', ref: 'k', text: 'piece-one', children: ['piece-two', { role: 'text', text: 'piece-three' }] },
        { role: 'paragraph', ref: 'a', text: 'saw piece-two' },
        { role: 'paragraph', ref: 'b', text: 'saw piece-three' },
        { role: 'paragraph', ref: 'c', text: 'prefix abc' }
      ],
      { ...none, secretRefs: new Set(['k']), secrets: ['ab', 'abc'] }
    );
    expect(out.nodes.slice(1).map((n) => (n as RawNode).text)).toEqual([`saw ${REDACTED}`, `saw ${REDACTED}`, `prefix ${REDACTED}`]);
    expect(out.echoes).toBe(3);
  });

  it('scrubs a whole reply, error details included, but never the driver’s own refs or the protocol’s fixed words', () => {
    const error = { message: 'Nothing is button "edit me"', details: { candidates: [{ ref: 'abcdef:4', role: 'button', name: 'edit me', region: ['toolbar "edit"'] }], reason: 'gone', query: { scope: 'editor' } } };
    expect(scrubDeep(error, ['ed'])).toEqual({
      message: `Nothing is button "${REDACTED}it me"`,
      details: { candidates: [{ ref: 'abcdef:4', role: 'button', name: `${REDACTED}it me`, region: [`toolbar "${REDACTED}it"`] }], reason: 'gone', query: { scope: 'editor' } }
    });
    expect(scrubDeep({ context: { mode: 'edit', screen: 'editor', preview: { state: 'ready' } }, more: { continue: { scope: 'editor', offset: 2 } } }, ['ed'])).toEqual({
      context: { mode: 'edit', screen: 'editor', preview: { state: 'ready' } },
      more: { continue: { scope: 'editor', offset: 2 } }
    });
  });

  it('scrubs a whole reply, but never the driver’s own refs and paths', () => {
    const reply = { context: { preview: { path: '/s3cret-page' } }, node: { ref: 'abcdef:1', name: 'Hi s3cret', semantic: { node: 's3cret' } }, refs: ['abcdef:2'], after: 'abcdef:3', screenshots: { editor: { path: '/tmp/s3cret/1.png' } }, query: { name: 's3cret' } };
    const out = scrubDeep(reply, ['s3cret']);
    expect(out).toEqual({
      context: { preview: { path: `/${REDACTED}-page` } },
      node: { ref: 'abcdef:1', name: `Hi ${REDACTED}`, semantic: { node: REDACTED } },
      refs: ['abcdef:2'],
      after: 'abcdef:3',
      screenshots: { editor: { path: '/tmp/s3cret/1.png' } },
      query: { name: REDACTED }
    });
    expect(scrubDeep(reply, [])).toBe(reply);
  });
});

describe('shaping', () => {
  const raw: RawNode[] = [
    {
      role: 'generic',
      ref: 'g0',
      children: [
        { role: 'toolbar', name: 'Panels', ref: 't1', children: [{ role: 'button', name: 'Pages', ref: 'b1', pressed: true }] },
        { role: 'generic', ariaHidden: true, ref: 'h1', text: '/' },
        { role: 'generic', ref: 'g1', children: [{ role: 'button', name: 'Undo', ref: 'b2', disabled: true }, 'px'] },
        { role: 'combobox', name: 'Image', ref: 'c1', text: 'None', children: [{ role: 'option', name: 'None', ref: 'o1', selected: true }] },
        { role: 'spinbutton', name: 'Width', ref: 's1', text: '1280' },
        { role: 'main', name: 'Website preview', ref: 'm1', children: [{ role: 'iframe', ref: 'i1', children: [{ role: 'heading', name: 'Inside', ref: 'f2e1' }] }] },
        { role: 'generic', name: 'Saved', ref: 'g2' },
        { role: 'generic', ref: 'g3', active: true }
      ]
    }
  ];

  it('folds the editor’s unnamed wrappers and drops what assistive technology does not see', () => {
    const roots = shape(raw, 'editor');
    expect(roots.map((n) => n.role)).toEqual(['toolbar', 'button', 'text', 'combobox', 'spinbutton', 'main', 'generic', 'generic']);
    expect(roots[0].children[0]).toMatchObject({ role: 'button', name: 'Pages', pressed: true, regions: ['toolbar "Panels"'], pwRef: 'b1' });
    expect(roots[1]).toMatchObject({ name: 'Undo', disabled: true });
    expect(roots[2]).toMatchObject({ role: 'text', text: 'px' });
    // A named wrapper stays, and so does one focused on purpose; the page's own body, focused when nothing else is,
    // is folded.
    expect(roots.slice(6).map((n) => [n.pwRef, n.name, n.focused])).toEqual([
      ['g2', 'Saved', undefined],
      ['g3', undefined, true]
    ]);
    expect(focusFrom(shape([{ role: 'generic', ref: 'body', active: true, children: [{ role: 'button', name: 'B', ref: 'b' }] }], 'editor'))).toBeNull();
    // A wrapper with text of its own stays, with its ref.
    expect(shape([{ role: 'generic', ref: 't', text: 'Saved' }], 'editor')).toEqual([expect.objectContaining({ pwRef: 't', text: 'Saved' })]);
    expect(json(roots)).not.toContain('"h1"');
  });

  it('keeps the site’s wrappers in the preview: they are its structure', () => {
    const roots = shape(raw, 'preview');
    expect(roots.map((n) => n.pwRef)).toEqual(['g0']);
    expect(roots[0].children.map((n) => n.pwRef)).toEqual(['t1', 'g1', 'c1', 's1', 'm1', 'g2', 'g3']);
    expect(roots[0].children[1].children.map((n) => n.pwRef ?? n.text)).toEqual(['b2', 'px']);
  });

  it('reports a field’s text as its value and keeps a combobox’s options as children', () => {
    const roots = shape(raw, 'editor');
    expect(roots[3]).toMatchObject({ role: 'combobox', name: 'Image', value: 'None' });
    expect(roots[3].children.map((n) => [n.role, n.name, n.selected])).toEqual([['option', 'None', true]]);
    expect(roots[4]).toMatchObject({ role: 'spinbutton', value: '1280' });
    const [field] = shape([{ role: 'textbox', ref: 't', children: ['ab', { role: 'text', text: 'cd' }] }], 'preview');
    expect(field).toMatchObject({ value: 'abcd', children: [] });
    // An option alone is not the combobox's value.
    const [choice] = shape([{ role: 'combobox', ref: 'c', children: [{ role: 'option', name: 'One', ref: 'o', selected: true }] }], 'preview');
    expect(choice.value).toBeUndefined();
  });

  it('stops at an iframe in either scope: its document is a scope of its own', () => {
    const main = shape(raw, 'editor')[5];
    expect(main.children).toEqual([expect.objectContaining({ role: 'iframe', pwRef: 'i1', children: [], regions: ['main "Website preview"'] })]);
    expect(main.size).toBe(1);
    const [nested] = shape([{ role: 'iframe', ref: 'n', children: [{ role: 'heading', ref: 'x' }] }], 'preview');
    expect(nested.children).toEqual([]);
  });

  it('clips long strings and keeps those at the limit', () => {
    const [n] = shape([{ role: 'heading', name: 'x'.repeat(500), ref: 'h', text: 'y'.repeat(900) }], 'preview');
    expect(n.name).toBe(`${'x'.repeat(199)}…`);
    expect(n.text).toBe(`${'y'.repeat(299)}…`);
    const [m] = shape([{ role: 'heading', name: 'x'.repeat(200), ref: 'h', text: 'y'.repeat(300) }], 'preview');
    expect([m.name!.length, m.text!.length, m.name!.endsWith('x')]).toEqual([200, 300, true]);
  });
});

/** A list of `count` items, each with one child. */
function list(count: number, id = 'L'): Shaped[] {
  return shape(
    [{ role: 'list', name: 'Items', ref: id, children: Array.from({ length: count }, (_, i) => ({ role: 'listitem', ref: `${id}i${i}`, children: [{ role: 'link', name: `Item ${i}`, ref: `${id}l${i}` }] })) }],
    'preview'
  );
}

describe('bounding', () => {
  const opts = (shown: Set<Shaped>) => ({ shown, refFor: (n: Shaped) => `r:${n.pwRef}`, facts: new Map(), viewports: {} });

  it('fills the budget breadth first, so the top of the tree shows before any depth', () => {
    const roots = list(5);
    const shown = choose(roots, { maxNodes: 4 });
    expect([...shown].map((n) => n.pwRef)).toEqual(['L', 'Li0', 'Li1', 'Li2']);
    const [L] = render(roots, opts(shown));
    expect(L.children!.map((c) => c.ref)).toEqual(['r:Li0', 'r:Li1', 'r:Li2']);
    // What was left out says how much, and resumes after the last child shown.
    expect(L.more).toEqual({ children: 2, nodes: 4, continue: { within: 'r:L', after: 'r:Li2', offset: 3 } });
    expect(L.children![0].more).toEqual({ children: 1, nodes: 1, continue: { within: 'r:Li0', offset: 0 } });
  });

  it('stops at a depth', () => {
    const roots = list(2);
    const ids = (depth: number) => [...choose(roots, { maxNodes: 100, depth })].map((n) => n.pwRef);
    expect(ids(0)).toEqual(['L']);
    expect(ids(1)).toEqual(['L', 'Li0', 'Li1']);
    expect(ids(2)).toEqual(['L', 'Li0', 'Li1', 'Ll0', 'Ll1']);
    expect(render(roots, opts(choose(roots, { maxNodes: 100, depth: 1 })))[0].children![0].more).toMatchObject({ children: 1 });
  });

  it('reports top-level nodes left out', () => {
    const roots = [...list(1, 'A'), ...list(3, 'B')];
    const shown = choose(roots, { maxNodes: 1 });
    expect(rootsLeft(roots, shown)).toEqual({ children: 1, nodes: 7 });
    expect(rootsLeft(roots, choose(roots, { maxNodes: 20 }))).toBeNull();
  });

  it('marks what is out of view on any side, scrolled out of a panel, blocked by a dialog, or carries the page’s ids', () => {
    const at = (box: { x: number; y: number; width: number; height: number }, f?: ElementFacts) => {
      const [n] = shape([{ role: 'link', name: 'L', ref: 'f', box }], 'preview');
      return describeNode(n, { refFor: () => 'r1', facts: new Map(f ? [[n, f]] : []), viewports: { preview: { width: 1000, height: 800 } } });
    };
    expect(at({ x: 10, y: 1400.4, width: 50.2, height: 20 }, facts({ blocked: true, semantic: { ctx: 'page:p|n', node: 'link' }, setsize: 40, posinset: 3 }))).toEqual({
      role: 'link',
      name: 'L',
      ref: 'r1',
      box: { x: 10, y: 1400, width: 50, height: 20 },
      offscreen: true,
      blocked: true,
      semantic: { ctx: 'page:p|n', node: 'link' },
      setsize: 40,
      posinset: 3
    });
    for (const box of [
      { x: -60, y: 10, width: 50, height: 20 },
      { x: 1000, y: 10, width: 50, height: 20 },
      { x: 10, y: -30, width: 50, height: 20 }
    ])
      expect(at(box).offscreen).toBe(true);
    const visible = at({ x: -20, y: 790, width: 50, height: 40 }, facts());
    expect(visible).not.toHaveProperty('offscreen');
    expect(visible).not.toHaveProperty('blocked');
    expect(visible).not.toHaveProperty('semantic');
    expect(at({ x: 10, y: 10, width: 50, height: 20 }, facts({ clipped: true })).offscreen).toBe(true);
  });
});

describe('finding and context', () => {
  const page = shape(
    [
      { role: 'banner', ref: 'b', children: [{ role: 'navigation', name: 'Main', ref: 'n1', children: [{ role: 'link', name: 'About', ref: 'a1' }, { role: 'navigation', name: 'Sub', ref: 'n3' }] }] },
      { role: 'contentinfo', ref: 'c', children: [{ role: 'navigation', name: 'Explore', ref: 'n2', children: [{ role: 'link', name: 'About  ', ref: 'a2' }, { role: 'link', name: 'About the studio', ref: 'a3' }, { role: 'button', name: 'About', ref: 'a4' }] }] }
    ],
    'preview'
  );

  it('tells similarly named controls apart by region, matching names exactly unless asked not to', () => {
    expect(find(page, { role: 'link', name: 'About' }).map((n) => n.pwRef)).toEqual(['a1', 'a2']);
    expect(find(page, { role: 'link', name: 'about' }).map((n) => n.pwRef)).toEqual([]);
    expect(find(page, { role: 'link', name: 'About', region: 'contentinfo' }).map((n) => n.pwRef)).toEqual(['a2']);
    expect(find(page, { role: 'link', name: 'About', region: 'main' }).map((n) => n.pwRef)).toEqual(['a1']);
    expect(find(page, { role: 'link', name: 'about', exact: false }).map((n) => n.pwRef)).toEqual(['a1', 'a2', 'a3']);
    expect(find(page, { name: 'About' }).map((n) => n.pwRef)).toEqual(['a1', 'a2', 'a4']);
    expect(find(shape([{ role: 'link', name: 'About' }], 'preview'), { role: 'link', name: 'About' })).toEqual([]);
    expect(find(page, { role: 'link', name: 'About', region: 'navigation "Explore"' }).map((n) => n.regions)).toEqual([['contentinfo', 'navigation "Explore"']]);
  });

  it('finds regions to search in, outermost only, by the label their contents carry however long', () => {
    expect(regionNodes(page, 'navigation').map((n) => n.pwRef)).toEqual(['n1', 'n2']);
    const long = 'N'.repeat(250);
    const tree = shape([{ role: 'navigation', name: long, ref: 'L', children: [{ role: 'link', name: 'x', ref: 'x' }] }, { role: 'navigation', name: 'Refless' }], 'preview');
    const [link] = find(tree, { role: 'link' });
    expect(link.regions).toEqual([`navigation "${long}"`]);
    expect(regionNodes(tree, link.regions[0]).map((n) => n.pwRef)).toEqual(['L']);
    expect(regionNodes(tree, long).map((n) => n.pwRef)).toEqual(['L']);
    expect(regionNodes(tree, 'Refless')).toEqual([]);
    expect(regionNodes(page, 'contentinfo').map((n) => n.pwRef)).toEqual(['c']);
    expect(regionNodes(page, 'Sub').map((n) => n.pwRef)).toEqual(['n3']);
    expect(regionNodes(page, 'nothing')).toEqual([]);
  });

  it('reads the mode, the topmost dialog, focus and the selection toolbar from the editor', () => {
    const editor = shape(
      [
        { role: 'toolbar', name: 'Row actions', ref: 'x' },
        { role: 'group', name: 'Mode', ref: 'm', children: [{ role: 'button', name: 'Edit', ref: 'e' }, { role: 'button', name: 'Preview', ref: 'p', pressed: true }] },
        { role: 'main', name: 'Website preview', ref: 'w', active: true, children: [{ role: 'toolbar', name: 'Zoom', ref: 'z' }, { role: 'toolbar', name: 'Split hero actions', ref: 't', children: [{ role: 'button', name: 'Move up', ref: 'u', active: true }] }] },
        { role: 'dialog', name: 'Settings', ref: 'd1' },
        { role: 'alertdialog', name: 'Discard?', ref: 'd2' }
      ],
      'editor'
    );
    expect(modeFrom(editor)).toBe('preview');
    expect(dialogFrom(editor)?.name).toBe('Discard?');
    expect(focusFrom(editor)?.name).toBe('Move up');
    expect(selectionToolbar(editor)?.name).toBe('Split hero actions');
    expect(modeFrom(shape([{ role: 'group', name: 'Mode', ref: 'm', children: [{ role: 'button', name: 'Edit', ref: 'e', pressed: true }] }], 'editor'))).toBe('edit');
    expect(modeFrom(shape([{ role: 'button', name: 'Edit', ref: 'x', pressed: true }], 'editor'))).toBeNull();
    expect(selectionToolbar(shape([{ role: 'toolbar', name: 'Row actions', ref: 'x' }], 'editor'))).toBeNull();
    expect(findByPwRef(editor, 'u')?.name).toBe('Move up');
    expect([...walk(editor)].length).toBe(10);
  });
});

describe('refs', () => {
  const base = { generation: 1, scope: 'preview' as const, opening: '/p#1', doc: '100.5|/', pwRef: 'f3e24', role: 'heading', name: 'Calm', semantic: null };

  it('gives the same element in the same document the same ref, and anything else another', () => {
    const r = new RefRegistry();
    const a = r.mint(base);
    expect(a).toMatch(/^[0-9a-f]{6}:\d+$/);
    expect(looksLikeRef(a)).toBe(true);
    expect(r.mint({ ...base })).toBe(a);
    for (const change of [{ doc: '200.1|/' }, { generation: 2 }, { opening: '/p#2' }, { scope: 'editor' as const }, { pwRef: 'f3e25' }, { role: 'link' }, { name: 'Calmer' }, { semantic: '{"ctx":"a","node":"b"}' }])
      expect(r.mint({ ...base, ...change }), JSON.stringify(change)).not.toBe(a);
    expect(r.get(a)).toMatchObject({ ...base, token: a });
  });

  it('forgets the oldest past its limit, and everything when cleared', () => {
    const r = new RefRegistry(3);
    const first = r.mint({ ...base, pwRef: 'e1' });
    const second = r.mint({ ...base, pwRef: 'e2' });
    for (const p of ['e3', 'e4']) r.mint({ ...base, pwRef: p });
    expect(r.size).toBe(3);
    expect(r.get(first)).toBeNull();
    // A forgotten element gets a new ref when seen again, which is kept; the next oldest goes.
    const again = r.mint({ ...base, pwRef: 'e1' });
    expect(again).not.toBe(first);
    expect(r.get(again)).toMatchObject({ pwRef: 'e1' });
    expect(r.get(second)).toBeNull();
    r.clear();
    expect(r.size).toBe(0);
    expect(r.get(again)).toBeNull();
  });

  it('never hands one session’s ref to another, however many sessions there are', () => {
    const registries = Array.from({ length: 200 }, () => new RefRegistry());
    const firsts = registries.map((r) => r.mint(base));
    expect(new Set(firsts).size).toBe(200);
    expect(registries[1].get(firsts[0])).toBeNull();
  });
});

describe('arguments', () => {
  const refused = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return e instanceof DriverError ? e.code : 'other';
    }
    return 'accepted';
  };

  it('ui.snapshot takes a scope, or a ref to look inside, bounds, and where to continue', () => {
    expect(parseSnapshotArgs({})).toEqual({ scope: 'all' });
    expect(parseSnapshotArgs({ within: 'ab12cd:3', offset: 4, maxNodes: 50, depth: 2, screenshot: true })).toMatchObject({ within: 'ab12cd:3', offset: 4, maxNodes: 50, depth: 2, screenshot: true });
    expect(parseSnapshotArgs({ scope: 'preview', after: 'ab12cd:9' })).toMatchObject({ scope: 'preview', after: 'ab12cd:9' });
    expect(parseSnapshotArgs({ scope: 'editor', offset: 3 })).toMatchObject({ scope: 'editor', offset: 3 });
    for (const bad of [
      { scope: 'site' },
      { within: 'e12' },
      { within: 'ab12:3' },
      { within: 'ab12cd:3', scope: 'editor' },
      { offset: 2 },
      { after: 'ab12cd:1' },
      { within: 'ab12cd:3', offset: -1 },
      { within: 'ab12cd:3', offset: 1.5 },
      { depth: 1.5 },
      { depth: 51 },
      { maxNodes: 1001 },
      { maxNodes: 0 },
      { screenshot: 'yes' },
      { selector: 'h1' },
      { scope: 'preview', after: 'nope' }
    ])
      expect(refused(() => parseSnapshotArgs(bad)), JSON.stringify(bad)).toBe('BAD_REQUEST');
  });

  it('ui.locate takes a ref alone, or a role with a name, region or ref to search in', () => {
    expect(parseLocateArgs({ ref: 'ab12cd:3' })).toEqual({ ref: 'ab12cd:3' });
    expect(parseLocateArgs({ role: 'link', name: 'About', region: 'contentinfo' })).toEqual({ role: 'link', name: 'About', region: 'contentinfo', scope: 'all' });
    expect(parseLocateArgs({ role: 'button', within: 'ab12cd:9', exact: false, name: 'edit' })).toEqual({ role: 'button', within: 'ab12cd:9', exact: false, name: 'edit', scope: 'all' });
    for (const bad of [
      {},
      { ref: 'ab12cd:3', role: 'button' },
      { ref: 'nope' },
      { role: 'Button!' },
      { role: 'link', region: 'x', within: 'ab12cd:1' },
      { role: 'link', within: 'ab12cd:1', scope: 'preview' },
      { role: 'link', name: ' ' },
      { role: 'link', exact: 'yes' },
      { role: 'link', region: ' ' },
      { role: 'link', scope: 'site' }
    ])
      expect(refused(() => parseLocateArgs(bad)), JSON.stringify(bad)).toBe('BAD_REQUEST');
  });

  it('finds the page’s elements by their ids as the bridge does, quoting what needs it', () => {
    expect(semanticSelector({ ctx: 'page:p1|n_2', node: 'heading' })).toBe('[data-so-ctx="page:p1|n_2"][data-so-node="heading"]');
    expect(semanticSelector({ ctx: 'c', node: 'n', items: 'i1' })).toBe('[data-so-ctx="c"][data-so-node="n"][data-so-items="i1"]');
    expect(semanticSelector({ ctx: 'a"b\\c', node: 'n\nx', items: 'i1,"i2"' })).toBe('[data-so-ctx="a\\"b\\\\c"][data-so-node="n\\a x"][data-so-items="i1,\\"i2\\""]');
  });
});
