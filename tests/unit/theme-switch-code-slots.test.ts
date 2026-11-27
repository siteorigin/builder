/**
 * A theme switch to a code (Svelte) implementation reports content a placement holds in a slot the new code would not
 * show, as it does for managed definitions (#1077).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { getTheme } from '@catalogue/index';
import { applyOperations } from '@engine/apply';
import { codeContractNames } from '../../src/main/codecheck';
import { ProjectSession } from '../../src/main/project/session';

const SPLIT = 'layout.split';
const alt = getTheme('foundation-alt');
const at = alt.components.findIndex((c) => c.componentId === SPLIT);
const shipped = alt.components[at];

const dirs: string[] = [];
const open: ProjectSession[] = [];
afterEach(async () => {
  alt.components[at] = shipped;
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

/** A Split layout whose columns render the given markup for Primary and Secondary. */
const splitSource = (primary: string, secondary: string) => `<script>
  let { slot_primary = undefined, slot_secondary = undefined, so_o } = $props();
</script>

<section class={so_o?.root}>
  <div class={so_o?.container}>
    <div class={so_o?.primary}>${primary}</div>
    <div class={so_o?.secondary}>${secondary}</div>
  </div>
</section>
`;
const ALL = splitSource('{@render slot_primary?.()}', '{@render slot_secondary?.()}');
// Takes both snippets, but only tests Secondary: what is placed there never reaches the page.
const SOME = splitSource('{@render slot_primary?.()}', '{#if slot_secondary}<hr />{/if}');
const NONE = splitSource('', '');

/** Foundation Alt's Split layout as a code component with this source, keeping the managed one's contract. */
function codeSplit(base: ComponentDefinition, source: string): ComponentDefinition {
  const { tree: _tree, ...rest } = structuredClone(base);
  return { ...rest, kind: 'code', source, sourcePath: `src/lib/components/theme/SplitLayout-${base.id.split('.')[0]}.svelte` } as ComponentDefinition;
}

/** A blank site with a Split layout on Home holding a paragraph in each of its two slots. */
function filledSplit(): { s: ProjectState; id: string } {
  let s = createStarterState('blank', 'Split', false);
  const owner = { kind: 'page' as const, id: s.site.homePageId };
  const ins = applyOperations(s, [{ type: 'node.insert', owner, componentId: SPLIT }]);
  const id = ins.results[0].nodeId as string;
  s = applyOperations(ins.state, [
    { type: 'node.insert', owner, parentId: id, slot: 'primary', primitive: 'paragraph', text: 'Left words' },
    { type: 'node.insert', owner, parentId: id, slot: 'secondary', primitive: 'paragraph', text: 'Right words' }
  ]).state;
  return { s, id };
}

/** The code check's reading of each source, as the session gives it to the switch. */
describe('codeContractNames', () => {
  it('counts a slot as shown only where the code renders it or hands it on', async () => {
    expect((await codeContractNames(ALL))?.shown.sort()).toEqual(['slot_primary', 'slot_secondary']);
    expect((await codeContractNames(SOME))?.shown).toEqual(['slot_primary']);
    expect((await codeContractNames(NONE))?.shown).toEqual([]);
    // Taken under another name and handed to a snippet the code renders, it still shows.
    const handed = `<script>\n  let { slot_primary: body = undefined } = $props();\n</script>\n\n{#snippet frame(inner)}<div>{@render inner?.()}</div>{/snippet}\n{@render frame(body)}\n`;
    expect((await codeContractNames(handed))?.shown).toEqual(['slot_primary']);
    // A theme's slot may be named outside the camelCase that saving declares: its snippet prop still counts.
    const snake = `<script>\n  let { slot_related_links = undefined } = $props();\n</script>\n\n<aside>{@render slot_related_links?.()}</aside>\n`;
    expect((await codeContractNames(snake))?.shown).toEqual(['slot_related_links']);
  });
});

describe('a theme switch to a code implementation with filled slots (#1077)', () => {
  const session = async (s: ProjectState) => {
    const dir = mkdtempSync(join(tmpdir(), 'so-code-slots-'));
    dirs.push(dir);
    const ps = await ProjectSession.create(dir, s);
    open.push(ps);
    return ps;
  };

  it('switches when the code renders every filled slot, keeping what each holds', async () => {
    const { s, id } = filledSplit();
    alt.components[at] = codeSplit(shipped, ALL);
    const ps = await session(s);
    const before = structuredClone((ps.state.pages[ps.state.site.homePageId].nodes[id] as InstanceNode).slots);
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.error?.message).toBeUndefined();
    expect(ps.state.site.themeId).toBe('foundation-alt');
    const node = ps.state.pages[ps.state.site.homePageId].nodes[id] as InstanceNode;
    expect(ps.state.components[node.definitionId].kind).toBe('code');
    expect(node.slots).toEqual(before);
  });

  it('refuses, naming only the slot the code would not show, when it renders some of them', async () => {
    const { s } = filledSplit();
    alt.components[at] = codeSplit(shipped, SOME);
    const ps = await session(s);
    const revision = ps.revision;
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONFLICT');
    expect(r.error?.message).toMatch(/would no longer show the content in its "secondary" slot/);
    expect(r.error?.message).not.toMatch(/"primary" slot/);
    expect(ps.state.site.themeId).toBe('foundation');
    expect(ps.revision).toBe(revision);
  });

  it('refuses, naming every filled slot, when it renders none of them', async () => {
    const { s } = filledSplit();
    alt.components[at] = codeSplit(shipped, NONE);
    const ps = await session(s);
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/would no longer show the content in its "primary" slot/);
    expect(r.error?.message).toMatch(/would no longer show the content in its "secondary" slot/);
    expect(ps.state.site.themeId).toBe('foundation');
  });

  it('holds back content when the new code cannot be read', async () => {
    const { s } = filledSplit();
    alt.components[at] = codeSplit(shipped, '<div>{#if}</div>');
    const ps = await session(s);
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/code could not be read, so it may not show the content in its "primary" slot/);
    expect(ps.state.site.themeId).toBe('foundation');
  });

  it('leaves code unjudged without the code check’s reading (an edit worked out before the session checks it)', () => {
    const { s } = filledSplit();
    alt.components[at] = codeSplit(shipped, NONE);
    expect(applyOperations(s, [{ type: 'theme.apply', themeId: 'foundation-alt' }]).state.site.themeId).toBe('foundation-alt');
  });

  /** The project with its installed Split layout as code that shows only Primary. */
  const installedSome = () => {
    const { s, id } = filledSplit();
    const installed = s.components[(s.pages[s.site.homePageId].nodes[id] as InstanceNode).definitionId];
    s.components[installed.id] = codeSplit(installed, SOME);
    return s;
  };

  it('does not count content the installed code already leaves out', async () => {
    // The new code differs from the installed one but shows Primary too: Secondary was hidden already.
    alt.components[at] = codeSplit(shipped, SOME.replace('<hr />', '<hr class="rule" />'));
    const ps = await session(installedSome());
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.error?.message).toBeUndefined();
    expect(ps.state.site.themeId).toBe('foundation-alt');
  });

  it('still counts the content the installed code shows', async () => {
    alt.components[at] = codeSplit(shipped, NONE);
    const ps = await session(installedSome());
    const r = await ps.apply({ operations: [{ type: 'theme.apply', themeId: 'foundation-alt' }] }, { label: 'switch' });
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/would no longer show the content in its "primary" slot/);
    expect(r.error?.message).not.toMatch(/"secondary" slot/);
  });
});
