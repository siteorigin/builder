/**
 * A layout's previous and next links are in a `nav` named by an entry field (#877). Entry content offers that name,
 * so an author can give it their own words or clear it, which ungrouping needs, without every container offering one.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ElementNode, GraphNode, OwnerRef, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';

/** Renderer code, outside the Node type-check project: loaded by path at run time. */
const PANEL_PATH = '../../src/renderer/src/panels/EntryFields';
let Panel: FunctionComponent<{ state: ProjectState; owner: OwnerRef; node: GraphNode }>;

beforeAll(async () => {
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    matchMedia: () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    builder: { platform: 'test' }
  };
  Panel = (await import(PANEL_PATH)).EntryFieldsSection;
});

const POSTS: OwnerRef = { kind: 'template', id: 'posts' };
const run = (s: ProjectState, ...ops: EditOperation[]) => applyOperations(s, ops).state;
const blog = () => run(createStarterState('business', 'Riverside Studio', false), { type: 'collection.create', collectionId: 'posts' });
const named = (s: ProjectState, name: string) => Object.values(s.collections.posts.settings.template.nodes).find((n) => n.name === name) as ElementNode;
const offered = (s: ProjectState, name: string) => renderToStaticMarkup(createElement(Panel, { state: s, owner: POSTS, node: named(s, name) })).includes('data-testid="entry-field-ariaLabel"');

describe('a layout element’s accessible name in Entry content', () => {
  it('is offered on a nav and on a named element, and on no other container', () => {
    let s = blog();
    expect(offered(s, 'Previous and next')).toBe(true);
    expect(offered(s, 'Links')).toBe(false);
    // Retagged, the element keeps its name, which is still there to clear.
    const id = named(s, 'Previous and next').id;
    s = run(s, { type: 'node.setContent', owner: POSTS, nodeId: id, field: 'tag', value: 'div' });
    expect(offered(s, 'Previous and next')).toBe(true);
    s = run(s, { type: 'node.setBinding', owner: POSTS, nodeId: id, field: 'ariaLabel', binding: null });
    expect(named(s, 'Previous and next').ariaLabel).toBeUndefined();
    expect(offered(s, 'Previous and next')).toBe(false);
  });
});
