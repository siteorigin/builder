import { useMemo, useState } from 'react';
import { Code, Component, Copy, FileCode2, FileText, House, Info, MousePointerClick, Palette, PanelTop, Pencil, Sparkles, Split, Trash2, Users } from 'lucide-react';
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, OwnerRef, PageDoc, ProjectState, ResponsiveStyles, StyleValue } from '@shared/types';
import { isBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { effectiveTokens } from '@generator/index';
import { catalogueComponent } from '@catalogue/index';
import { findParent, instancesOf } from '@engine/tree';
import { applyOps, setState, useStore } from '../store';
import { DraftInput, Field, openSection, Section, SwitchRow } from '../components/ui';
import { ImageEditor, LinkEditor, PropField, ScalarEditor, IconPicker } from './PropEditors';
import { StyleControls } from './StyleControls';
import { boundaryOf, ownerLabel, pagesUsingShell, refLabel, resolveRef } from '../lib/model';
import { askAiAbout, deleteSelection, duplicateSelection, structuralTarget } from '../lib/actions';

type ListOp = { kind: 'insert' } | { kind: 'remove'; itemId: string } | { kind: 'move'; itemId: string; index: number } | { kind: 'field'; itemId: string; field: string; value: unknown };

function listOps(owner: OwnerRef, nodeId: string, prop: string, op: ListOp): EditOperation {
  switch (op.kind) {
    case 'insert':
      return { type: 'instance.listInsert', owner, nodeId, prop };
    case 'remove':
      return { type: 'instance.listRemove', owner, nodeId, prop, itemId: op.itemId };
    case 'move':
      return { type: 'instance.listMove', owner, nodeId, prop, itemId: op.itemId, index: op.index };
    case 'field':
      return { type: 'instance.setProp', owner, nodeId, prop, itemId: op.itemId, field: op.field, value: op.value };
  }
}

/** Default styles a definition gives a node (base + selected variant), used as inherited placeholders. */
function inheritedStyles(def: ComponentDefinition, nodeId: string, variant?: string): ResponsiveStyles {
  const base = def.tree?.nodes[nodeId]?.styles ?? {};
  const v = variant ?? def.defaultVariant;
  const vs = (v && def.variants?.[v]?.styles?.[nodeId]) || {};
  const out: ResponsiveStyles = {};
  for (const scope of ['base', 'phone', 'tablet', 'desktop'] as const) {
    const merged = { ...(base[scope] ?? {}), ...(vs[scope] ?? {}) };
    if (Object.keys(merged).length) out[scope] = merged;
  }
  return out;
}

export function Inspector() {
  const snap = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const pageId = useStore((s) => s.pageId);
  const definitionMode = useStore((s) => s.definitionMode);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens, snap?.state.site.themeId]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!snap) return null;
  const st = snap.state;
  const editingDef = definitionMode ? st.components[definitionMode.definitionId] : undefined;
  // While editing a component everywhere, every route (canvas, Layers, nothing selected) shows that component.
  const throughPlacement = !!selection && selection.instancePath.length > 0 && (() => {
    const inst = resolveRef(st, { owner: selection.owner, instancePath: [], nodeId: selection.instancePath[0] }).node;
    return inst?.kind === 'instance' && inst.definitionId === editingDef?.id;
  })();
  if (editingDef && (!selection || (selection.owner.kind === 'component' && selection.owner.id === editingDef.id) || !throughPlacement)) {
    // Outside picks (another section) show the overview: the mode edits this component only.
    const node = selection && selection.owner.kind === 'component' ? editingDef.tree?.nodes[selection.nodeId] : undefined;
    return (
      <div className="panel-body" key={selection ? JSON.stringify(selection) : 'def-overview'}>
        {node ? <DefinitionNodeInspector state={st} def={editingDef} node={node} tokens={tokens} /> : <DefinitionOverview state={st} def={editingDef} />}
      </div>
    );
  }
  if (!selection) return pageId ? <PageSettings page={st.pages[pageId]} state={st} /> : null;
  const r = resolveRef(st, selection);
  if (!r.node)
    return (
      <div className="empty-insp">
        <MousePointerClick />
        <span>The selected element no longer exists.</span>
      </div>
    );
  return (
    <div className="panel-body" key={JSON.stringify(selection)}>
      {definitionMode && selection.instancePath.length === 1 && r.def?.id === definitionMode.definitionId ? (
        <DefinitionNodeInspector state={st} def={r.def} node={r.node} tokens={tokens} />
      ) : !selection.instancePath.length && r.node.kind === 'instance' ? (
        <InstanceInspector state={st} owner={selection.owner} node={r.node} tokens={tokens} selection={selection} />
      ) : selection.instancePath.length ? (
        <PartInspector state={st} selection={selection} tokens={tokens} />
      ) : (
        <PrimitiveInspector state={st} owner={selection.owner} node={r.node} tokens={tokens} selection={selection} />
      )}
    </div>
  );
}

/** Sticky inspector header: what is selected, who a change affects, and quick jumps to its sections. */
function Header({ title, badge, children, icon, jumps }: { title: string; badge?: React.ReactNode; children?: React.ReactNode; icon?: React.ReactNode; jumps?: Array<{ id: string; label: string }> }) {
  return (
    <div className="insp-head">
      <div className="insp-title">
        {icon}
        <h3 title={title}>{title}</h3>
        {badge}
      </div>
      {children}
      {jumps && jumps.length > 1 && (
        <nav className="insp-jump" aria-label="Jump to section">
          {jumps.map((j) => (
            <button key={j.id} onClick={() => openSection(j.id)}>
              {j.label}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

function ScopeNote({ owner, state, def }: { owner: OwnerRef; state: ProjectState; def?: ComponentDefinition }) {
  if (owner.kind === 'shell')
    return (
      <div className="scope-note shared">
        <Users />
        <span>
          <strong>Shared {owner.id}.</strong> Changes appear on all {pagesUsingShell(state)} page{pagesUsingShell(state) === 1 ? '' : 's'} that show it.
        </span>
      </div>
    );
  if (owner.kind === 'component')
    return (
      <div className="scope-note definition">
        <Component />
        <span>
          <strong>Component design.</strong> Changes apply everywhere {def?.name ?? 'this component'} is used.
        </span>
      </div>
    );
  return (
    <div className="scope-note instance">
      <Info />
      <span>
        <strong>Only here</strong>, on the {ownerLabel(state, owner)} page. Other pages are not affected.
      </span>
    </div>
  );
}

function InstanceInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: InstanceNode; tokens: ReturnType<typeof effectiveTokens>; selection: ElementRef }) {
  const scope = useStore((s) => s.styleScope);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const def = state.components[node.definitionId];
  if (!def) return null;
  const variants = Object.entries(def.variants ?? {});
  const uses = instancesOf(state, def.id).length;
  const partIds = def.kind === 'managed' ? Object.keys(def.parts) : [];
  const rootPart = def.parts.root;
  const set = (prop: string, value: unknown) => void applyOps([{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }], `Edit ${def.properties[prop]?.label ?? prop}`, `${node.id}:${prop}`);
  const onStyle = (partId: string) => (property: string, value: StyleValue | null) =>
    void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId, scope, property, value }], `Style ${def.parts[partId]?.label ?? partId}`, `${node.id}:${partId}:${scope}:${property}`);
  return (
    <>
      <Header
        title={node.name ?? def.name}
        icon={<span className={`layer-kind ${owner.kind === 'shell' ? 'shell' : 'instance'}`}>{owner.kind === 'shell' ? <PanelTop /> : <Component />}</span>}
        badge={<span className="badge" title={def.owner === 'project' ? 'A component made in this project' : 'A component from the Foundation theme'}>{def.owner === 'project' ? (def.kind === 'code' ? 'Code component' : 'Your component') : 'Theme component'}</span>}
        jumps={[{ id: 'content', label: 'Content' }, ...(def.kind === 'managed' ? [{ id: 'style', label: 'Style' }] : []), { id: 'component', label: 'Component' }]}
      >
        <ScopeNote owner={owner} state={state} />
      </Header>
      <Section title="Content" id="content">
        {Object.keys(def.properties).length === 0 && <p className="faint" style={{ margin: 0 }}>This component has no content properties. Add elements inside it from Insert.</p>}
        {Object.entries(def.properties).map(([name, schema]) => (
          <PropField
            key={name}
            name={name}
            schema={schema}
            value={node.props[name] ?? schema.default}
            onChange={(v) => set(name, v)}
            onList={(op) => void applyOps([listOps(owner, node.id, name, op)], `Edit ${schema.label}`, op.kind === 'field' ? `${node.id}:${name}:${op.itemId}:${op.field}` : undefined)}
            state={state}
          />
        ))}
      </Section>
      {def.kind === 'managed' && (
        <Section title="Style" id="style" defaultOpen={false} scope={(() => {
          const n = Object.values(node.overrides ?? {}).reduce((t, r) => t + Object.values(r ?? {}).reduce((u, sc) => u + Object.keys(sc ?? {}).length, 0), 0);
          return n ? `${n} change${n === 1 ? '' : 's'} here` : undefined;
        })()}>
          <span className="field-hint">Styles the whole {def.name.toLowerCase()}. To style one part, such as a heading, select it on the page or in Layers.</span>
          {variants.length > 1 && <Field label="Design variant">{<select className="select" value={node.variant ?? def.defaultVariant} onChange={(e) => void applyOps([{ type: 'instance.setVariant', owner, nodeId: node.id, variant: e.target.value }], 'Change variant')}>
            {variants.map(([id, v]) => (
              <option key={id} value={id}>
                {v.label}
              </option>
            ))}
          </select>}</Field>}
          <StyleControls
            styles={node.overrides?.root}
            inherited={inheritedStyles(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variant)}
            allowed={rootPart?.styleControls}
            tokens={tokens}
            onSet={onStyle('root')}
            onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, partId: 'root', scope: sc }], 'Reset overrides')}
            target={`the ${def.name.toLowerCase()} itself`}
          />
          {partIds.length > 1 && (
            <div className="field-hint">
              Parts:{' '}
              {partIds
                .filter((p) => p !== 'root')
                .map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <button className="link-btn" onClick={() => setState({ selection: { owner, instancePath: [node.id], nodeId: def.parts[p].nodeId, partId: p } })}>
                      {def.parts[p].label}
                    </button>
                  </span>
                ))}
            </div>
          )}
        </Section>
      )}
      <Section title="Component" id="component" defaultOpen={false} scope={`Used ${uses === 1 ? 'once' : `${uses} times`}`}>
        {def.description && (
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {def.description}
          </p>
        )}
        <div className="action-grid">
          <button className="btn btn-sm" onClick={() => askAiAbout(selection)}>
            <Sparkles /> Ask AI
          </button>
          {def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'edit-definition', ref: selection } })}>
              <Pencil /> Edit everywhere…
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void applyOps([{ type: 'component.makeUnique', owner, nodeId: node.id }], 'Make unique')} title="Make a separate copy of this component for this placement, so its design can change on its own">
            <Split /> Make unique
          </button>
          {dev && def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => void applyOps([{ type: 'component.convertToCode', owner, nodeId: node.id }], 'Convert to code')} title="Create an editable Svelte copy">
              <Code /> Convert to code
            </button>
          )}
          {dev && (
            <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'source', definitionId: def.id } })}>
              <FileCode2 /> {dev && def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source'}
            </button>
          )}
          {owner.kind !== 'shell' && (
            <>
              <button className="btn btn-sm" onClick={() => void duplicateSelection()}>
                <Copy /> Duplicate
              </button>
              <button className="btn btn-sm btn-danger" onClick={() => void deleteSelection()}>
                <Trash2 /> Delete
              </button>
            </>
          )}
        </div>
      </Section>
      <Section title="Advanced" id="advanced" defaultOpen={false}>
        <Field label="Layer name">
          <DraftInput value={node.name ?? ''} placeholder={def.name} onCommit={(v) => void applyOps([{ type: 'node.rename', owner, nodeId: node.id, name: v }], 'Rename layer')} />
        </Field>
        {dev && (
          <p className="mono faint" style={{ margin: 0, userSelect: 'text' }}>
            {node.id} · {def.id}
          </p>
        )}
      </Section>
    </>
  );
}

function PartInspector({ state, selection, tokens }: { state: ProjectState; selection: ElementRef; tokens: ReturnType<typeof effectiveTokens> }) {
  const scope = useStore((s) => s.styleScope);
  const r = resolveRef(state, selection);
  const def = r.def!;
  const inst = r.instance!;
  const node = r.node!;
  const nested = selection.instancePath.length > 1;
  const owner = selection.owner;
  const partId = selection.partId;
  const part = partId ? def.parts[partId] : undefined;
  const boundary = boundaryOf(state, { ...selection, instancePath: selection.instancePath.slice(0, 1), nodeId: inst.id });
  const itemId = selection.itemPath?.[selection.itemPath.length - 1];

  // Content bound to this part
  const bindings: Array<{ prop?: string; item?: string; kind: string }> = [];
  const pushB = (v: unknown, kind: string) => {
    if (isBinding(v)) bindings.push('$prop' in v ? { prop: v.$prop, kind } : { item: v.$item, kind });
  };
  if (node.kind === 'text') pushB(node.text, 'text');
  if (node.kind === 'image') pushB(node.image, 'image');
  if (node.kind === 'link') (pushB(node.label, 'label'), pushB(node.link, 'link'));
  if (node.kind === 'icon') pushB(node.icon, 'icon');
  const contentList = Object.entries(def.properties).find(([, p]) => p.type === 'list' && bindings.some((b) => b.item && b.item in (p as { fields: object }).fields))?.[0];
  // A structural part (a card itself) has no content binding, but it still repeats once per list item:
  // find the list from the repeat that encloses it, so its Style scope says "All 3 cards" too.
  const repeatList = (() => {
    if (!def.tree) return undefined;
    let id: string | null | undefined = node.id;
    for (let guard = 0; id && guard < 50; guard++) {
      const n = def.tree.nodes[id];
      if (n && n.kind === 'repeat' && n.id !== node.id) return n.list.$prop;
      id = findParent(def.tree, id)?.parentId;
    }
    return undefined;
  })();
  const listProp = contentList ?? (repeatList && def.properties[repeatList]?.type === 'list' ? repeatList : undefined);
  const instOwner = owner;
  const instNodeId = selection.instancePath[0];

  return (
    <>
      <Header title={part?.label ?? refLabel(state, selection)} icon={<span className="layer-kind part"><MousePointerClick /></span>}>
        <div className={`scope-note ${owner.kind === 'shell' ? 'shared' : 'instance'}`}>
          {owner.kind === 'shell' ? <Users /> : <Info />}
          <span>
            Part of{' '}
            <button className="link" onClick={() => setState({ selection: boundary })} title="Select the whole component (Esc)">
              {def.name}
            </button>
            {listProp
              ? itemId
                ? `, in one of its ${((inst.props[listProp] as unknown[]) ?? []).length} ${(def.properties[listProp] as { label: string }).label.toLowerCase()}`
                : `, in all ${((inst.props[listProp] as unknown[]) ?? []).length} ${(def.properties[listProp] as { label: string }).label.toLowerCase()}`
              : ''}
            {owner.kind === 'shell' ? `, in the shared ${owner.id}. Changes appear on every page that shows it.` : `, only on the ${ownerLabel(state, owner)} page.`}
          </span>
        </div>
      </Header>
      {nested ? (
        <Section title="Content" id="part-content">
          <p className="muted" style={{ margin: 0 }}>This belongs to a component inside {def.name}. Change it with Edit everywhere on that component, or make {def.name} unique.</p>
        </Section>
      ) : bindings.length ? (
        <Section title="Content" id="part-content" scope={listProp ? (itemId ? `This ${(def.properties[listProp] as { itemLabel: string }).itemLabel.toLowerCase()} only` : undefined) : undefined}>
          {bindings.map((b, i) => {
            if (b.prop) {
              const schema = def.properties[b.prop];
              if (!schema) return null;
              return (
                <PropField
                  key={i}
                  name={b.prop}
                  schema={schema}
                  value={inst.props[b.prop] ?? schema.default}
                  state={state}
                  onChange={(v) => void applyOps([{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: b.prop!, value: v }], `Edit ${schema.label}`, `${instNodeId}:${b.prop}`)}
                  onList={(op) => void applyOps([listOps(instOwner, instNodeId, b.prop!, op)], `Edit ${schema.label}`)}
                />
              );
            }
            if (listProp && itemId) {
              const schema = def.properties[listProp] as Extract<ComponentDefinition['properties'][string], { type: 'list' }>;
              const field = schema.fields[b.item!];
              const item = ((inst.props[listProp] as Array<Record<string, unknown>>) ?? []).find((x) => x.id === itemId);
              if (!field || !item) return null;
              return (
                <Field key={i} label={`${field.label} for this ${schema.itemLabel.toLowerCase()}`}>
                  <ScalarEditor schema={field} value={item[b.item!]} state={state} onChange={(v) => void applyOps([{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: listProp, itemId, field: b.item!, value: v }], `Edit ${field.label}`, `${instNodeId}:${listProp}:${itemId}:${b.item}`)} />
                </Field>
              );
            }
            return null;
          })}
          {listProp && !itemId && (
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              Each {(def.properties[listProp] as { itemLabel: string }).itemLabel.toLowerCase()} has its own text: click one on the page to change it, or{' '}
              <button
                className="link-btn"
                onClick={() => {
                  setState({ selection: boundary });
                  // Land on the list itself: open Content, scroll below the sticky header, focus the first item.
                  setTimeout(() => {
                    openSection('content');
                    setTimeout(() => document.querySelector<HTMLElement>('#dock-panel-inspect .list-editor-head button.title')?.focus({ preventScroll: false }), 250);
                  }, 50);
                }}
              >
                open the {(def.properties[listProp] as { label: string }).label.toLowerCase()} list
              </button>
              .
            </p>
          )}
          {listProp && itemId && (
            <button className="btn btn-sm btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setState({ selection: boundary })}>
              Edit all {(def.properties[listProp] as { label: string }).label.toLowerCase()}
            </button>
          )}
        </Section>
      ) : (
        <Section title="Content" id="part-content">
          <p className="muted" style={{ margin: 0 }}>This is fixed in the component's design. To change it, select {def.name} and choose Edit everywhere, or Make unique for just this placement.</p>
        </Section>
      )}
      {part && !nested && def.kind === 'managed' && (
        <Section title="Style" id="part-style" scope={listProp ? `All ${((inst.props[listProp] as unknown[]) ?? []).length} ${(part.label ?? 'items').toLowerCase()}s` : undefined}>
          {listProp && <span className="field-hint">Style changes apply to the {(part.label ?? 'part').toLowerCase()} in every {(def.properties[listProp] as { itemLabel: string }).itemLabel.toLowerCase()}.</span>}
          <StyleControls
            styles={inst.overrides?.[partId!]}
            inherited={inheritedStyles(def, part.nodeId, inst.variant)}
            allowed={part.styleControls}
            tokens={tokens}
            onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, scope, property, value }], `Style ${part.label}`, `${instNodeId}:${partId}:${scope}:${property}`)}
            onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId, scope: sc }], 'Reset part overrides')}
          />
        </Section>
      )}
    </>
  );
}

function PrimitiveInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: GraphNode; tokens: ReturnType<typeof effectiveTokens>; selection: ElementRef }) {
  const scope = useStore((s) => s.styleScope);
  const content = (field: Extract<EditOperation, { type: 'node.setContent' }>['field'], value: unknown) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field, value }], `Edit ${field}`, `${node.id}:${field}`);
  const t = structuralTarget(selection);
  return (
    <>
      <Header title={refLabel(state, selection)}>
        <ScopeNote owner={owner} state={state} def={owner.kind === 'component' ? state.components[owner.id] : undefined} />
      </Header>
      <Section title="Content" id="prim-content">
        {node.kind === 'text' && (
          <>
            {!node.rich && (
              <Field label="Type">
                <select className="select" value={node.tag} onChange={(e) => content('tag', e.target.value)} aria-label="Text type">
                  {['h1', 'h2', 'h3', 'h4', 'p'].map((tg) => (
                    <option key={tg} value={tg}>
                      {tg === 'p' ? 'Paragraph' : `Heading ${tg.slice(1)}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Text" hint="Double-click the text on the canvas to edit it in place.">
              <DraftInput multiline value={Array.isArray(node.text) ? node.text.join('\n\n') : isBinding(node.text) ? '' : String(node.text)} onCommit={(v) => content('text', v)} />
            </Field>
          </>
        )}
        {node.kind === 'image' && !isBinding(node.image) && <ImageEditor value={node.image} onChange={(v) => content('image', v)} state={state} />}
        {node.kind === 'link' && (
          <>
            <Field label="Label">
              <DraftInput value={isBinding(node.label) ? '' : String(node.label)} onCommit={(v) => content('label', v)} />
            </Field>
            <Field label="Destination">{!isBinding(node.link) && <LinkEditor value={node.link} onChange={(v) => content('link', v)} state={state} />}</Field>
            <Field label="Appearance">
              <select className="select" value={String(node.appearance)} onChange={(e) => content('appearance', e.target.value)} aria-label="Appearance">
                <option value="primary">Primary button</option>
                <option value="secondary">Secondary button</option>
                <option value="text">Text with arrow</option>
                <option value="link">Underlined link</option>
              </select>
            </Field>
          </>
        )}
        {node.kind === 'icon' && <IconPicker value={isBinding(node.icon) ? 'sparkles' : String(node.icon)} onChange={(v) => content('icon', v)} />}
        {node.kind === 'element' && <p className="faint" style={{ margin: 0 }}>A layout container with {node.children.length} item{node.children.length === 1 ? '' : 's'}. Select it, then use Insert to add elements inside.</p>}
        <Field label="Anchor ID" hint="Lets links jump to this element, e.g. #services.">
          <DraftInput value={node.anchor ?? ''} placeholder="none" onCommit={(v) => content('anchor', v)} />
        </Field>
      </Section>
      <Section title="Style" id="prim-style">
        <StyleControls
          styles={node.styles}
          inherited={undefined}
          allowed={styleSetFor(node)}
          tokens={tokens}
          onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value }], `Style ${property}`, `${node.id}:${scope}:${property}`)}
          onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, scope: sc }], 'Reset styles')}
        />
      </Section>
      {t && owner.kind !== 'shell' && (
        <Section title="Actions" id="prim-actions" defaultOpen={false}>
          <div className="action-grid">
            <button className="btn btn-sm" onClick={() => askAiAbout(selection)}>
              <Sparkles /> Ask AI
            </button>
            {node.kind === 'element' && (
              <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'create-component', ref: t } })}>
                <Component /> Create component
              </button>
            )}
            <button className="btn btn-sm" onClick={() => void duplicateSelection()}>
              <Copy /> Duplicate
            </button>
            <button className="btn btn-sm btn-danger" onClick={() => void deleteSelection()}>
              <Trash2 /> Delete
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

function styleSetFor(node: GraphNode): string[] | undefined {
  const spacing = ['marginBlockStart', 'marginBlockEnd', 'paddingBlock', 'paddingInline'];
  const appearance = ['color', 'background', 'border', 'radius', 'shadow', 'opacity', 'hidden'];
  switch (node.kind) {
    case 'text':
      return ['textStyle', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'textAlign', 'maxWidth', ...spacing, ...appearance];
    case 'image':
      return ['width', 'maxWidth', 'aspectRatio', 'objectFit', 'radius', 'shadow', 'marginBlockStart', 'marginBlockEnd', 'opacity', 'hidden'];
    case 'link':
      return ['width', 'marginBlockStart', 'marginBlockEnd', 'color', 'background', 'radius', 'hidden'];
    case 'icon':
      return ['color', 'fontSize', 'background', 'radius', 'hidden'];
    case 'element':
      // Containers: layout, spacing, size and surface. Image-only and per-letter text controls do nothing here.
      return ['layout', 'columns', 'align', 'justify', 'wrap', 'gap', 'order', ...spacing, 'width', 'maxWidth', 'minHeight', 'marginInline', 'textAlign', 'color', 'background', 'border', 'radius', 'shadow', 'opacity', 'hidden'];
    default:
      return undefined;
  }
}

/** Component editing with nothing selected: what is being edited, where it is used, and how to start. */
function DefinitionOverview({ state, def }: { state: ProjectState; def: ComponentDefinition }) {
  const places = [...new Set(instancesOf(state, def.id).map((u) => u.label))];
  return (
    <>
      <Header title={def.name} icon={<span className="layer-kind definition"><Component /></span>} badge={<span className="badge plum">Everywhere</span>}>
        <div className="scope-note definition">
          <Component />
          <span>
            <strong>Editing {def.name}.</strong> Changes apply wherever it is used: {places.join(', ') || 'nowhere yet'}.
          </span>
        </div>
      </Header>
      <div className="empty-insp">
        <MousePointerClick />
        <span>Click part of {def.name} on the page, or pick a layer, to change its design.</span>
        <button className="btn btn-sm" onClick={() => useStore.getState().definitionMode && setState({ definitionMode: null, pageId: useStore.getState().definitionMode!.returnPageId, selection: null })}>
          Done editing
        </button>
      </div>
    </>
  );
}

function DefinitionNodeInspector({ state, def, node, tokens }: { state: ProjectState; def: ComponentDefinition; node: GraphNode; tokens: ReturnType<typeof effectiveTokens> }) {
  const scope = useStore((s) => s.styleScope);
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const uses = instancesOf(state, def.id).length;
  const partId = Object.entries(def.parts).find(([, p]) => p.nodeId === node.id)?.[0];
  // A copy of a theme component compares against the theme's design, so only real changes show as changes.
  const original = def.componentId ? catalogueComponent(state.site.themeId, def.componentId)?.tree?.nodes[node.id]?.styles : undefined;
  const changed: ResponsiveStyles | undefined = original
    ? Object.fromEntries(
        Object.entries(node.styles ?? {})
          .map(([sc, vals]) => [sc, Object.fromEntries(Object.entries(vals ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((original as ResponsiveStyles)[sc as keyof ResponsiveStyles]?.[k])))])
          .filter(([, vals]) => Object.keys(vals as object).length)
      )
    : node.styles;
  return (
    <>
      <Header title={partId && partId !== 'root' ? def.parts[partId].label : def.tree?.rootIds[0] === node.id ? def.name : refLabel(state, { owner, instancePath: [], nodeId: node.id })} badge={<span className="badge plum">Everywhere</span>}>
        <div className="scope-note definition">
          <Component />
          <span>
            <strong>Editing {def.name}.</strong> {uses === 1 ? 'Used once. Layout and style changes apply there and wherever you add it later.' : `Layout and style changes apply to all ${uses} placements, except where one has its own changes.`}
          </span>
        </div>
      </Header>
      {node.kind === 'text' && !isBinding(node.text) && (
        <Section title="Fixed text" id="def-text">
          <DraftInput multiline value={Array.isArray(node.text) ? node.text.join('\n\n') : String(node.text)} onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'text', value: v }], 'Edit definition text')} />
        </Section>
      )}
      <Section title="Style" id="def-style" scope={uses === 1 ? '1 placement' : `${uses} placements`}>
        <StyleControls
          styles={changed}
          inherited={original}
          designSizesWin
          tokens={tokens}
          allowed={styleSetFor(node)}
          onSet={(property, value) => {
            // Resetting a value restores the original design's value, when there is one.
            const restore = value === null ? original?.[scope]?.[property] : undefined;
            void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value: restore ?? value }], `Edit ${def.name} definition`, `${def.id}:${node.id}:${scope}:${property}`);
          }}
          onReset={
            original
              ? (only) => {
                  const ops: EditOperation[] = [];
                  for (const sc of (only ? [only] : Object.keys(changed ?? {})) as Array<keyof ResponsiveStyles>)
                    for (const prop of Object.keys(changed?.[sc] ?? {})) ops.push({ type: 'node.setStyle', owner, nodeId: node.id, scope: sc, property: prop, value: (original[sc]?.[prop] ?? null) as StyleValue | null });
                  if (ops.length) void applyOps(ops, `Restore ${def.name} design`);
                }
              : (sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, scope: sc }], 'Clear element styles')
          }
          resetLabel={original ? 'Restore original design' : 'Clear styles on this element'}
        />
      </Section>
    </>
  );
}

function PageSettings({ page, state }: { page: PageDoc; state: ProjectState }) {
  const previewing = useStore((s) => s.mode === 'preview');
  const [titleError, setTitleError] = useState<string | null>(null);
  if (!page) return null;
  const upd = (patch: Record<string, unknown>, label = 'Update page settings') => void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], label);
  const isHome = page.id === state.site.homePageId;
  return (
    <div className="panel-body">
      <Header title={page.title} icon={<span className="layer-kind">{isHome ? <House /> : <FileText />}</span>} badge={isHome ? <span className="badge accent">Home page</span> : undefined}>
        <span className="muted" style={{ fontSize: 13 }}>
          {previewing ? 'You are previewing. Switch to Edit in the toolbar to change things on the page.' : 'Settings for this page. Click anything on the page to change it.'}
        </span>
      </Header>
      <Section title="Page" id="page-basic">
        <Field label="Title" error={titleError}>
          <DraftInput
            value={page.title}
            onCommit={(v) => {
              if (!v.trim()) return setTitleError(`A page needs a title. Kept “${page.title}”.`);
              setTitleError(null);
              upd({ title: v.trim() }, 'Rename page');
            }}
          />
        </Field>
        <Field label="Address" hint={isHome ? 'The home page is always at /.' : 'Links to this page update automatically when you change it.'}>
          {isHome ? <input className="input" value="/" readOnly aria-label="Page address" /> : <DraftInput value={page.route} onCommit={(v) => upd({ route: v }, 'Change page address')} ariaLabel="Page address" />}
        </Field>
        <SwitchRow checked={page.shell !== 'none'} onChange={(v) => upd({ shell: v ? 'default' : 'none' })} label="Show shared header and footer" />
      </Section>
      <Section title="Search & sharing" id="page-seo">
        <Field label="Browser title" hint={`Default: ${isHome ? state.site.name : `${page.title} · ${state.site.name}`}`}>
          <DraftInput value={page.seo.title ?? ''} placeholder="Use default" onCommit={(v) => upd({ seoTitle: v })} />
        </Field>
        <Field label="Description" hint="Shown by search engines. About 150 characters.">
          <DraftInput multiline value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onCommit={(v) => upd({ description: v })} />
        </Field>
        <SwitchRow checked={!!page.seo.noindex} onChange={(v) => upd({ noindex: v })} label="Hide from search engines" hint="Search engines are asked not to list this page." />
      </Section>
      {useStore.getState().settings?.developerMode && (
      <Section title="Advanced" id="page-adv" defaultOpen={false}>
        {useStore.getState().settings?.developerMode && (
          <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'page-source', pageId: page.id } })}>
            <FileCode2 /> View generated source
          </button>
        )}
        <p className="mono faint" style={{ margin: 0, userSelect: 'text' }}>
          {page.id}
        </p>
      </Section>
      )}
      <div style={{ padding: 14 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => setState({ rightTab: 'styles' })}>
          <Palette /> Site styles: colours, fonts and spacing
        </button>
      </div>
    </div>
  );
}

