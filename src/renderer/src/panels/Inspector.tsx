import { useMemo } from 'react';
import { Code, Component, Copy, FileCode2, Globe, Info, Link2, MousePointerClick, PanelTop, Pencil, RotateCcw, Sparkles, Split, Trash2, Users } from 'lucide-react';
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, OwnerRef, PageDoc, ProjectState, ResponsiveStyles, StyleValue } from '@shared/types';
import { isBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { effectiveTokens } from '@generator/index';
import { instancesOf } from '@engine/tree';
import { applyOps, setState, useStore } from '../store';
import { DraftInput, Field, Section, Switch } from '../components/ui';
import { ImageEditor, LinkEditor, PropField, ScalarEditor, IconPicker } from './PropEditors';
import { ScopePicker, StyleControls } from './StyleControls';
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

function Header({ title, badge, children, icon }: { title: string; badge?: React.ReactNode; children?: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <div className="insp-head">
      <div className="insp-title">
        {icon}
        <h3>{title}</h3>
        {badge}
      </div>
      {children}
    </div>
  );
}

function ScopeNote({ owner, state, def }: { owner: OwnerRef; state: ProjectState; def?: ComponentDefinition }) {
  if (owner.kind === 'shell')
    return (
      <div className="scope-note shared">
        <Users />
        <span>
          <strong>Shared {owner.id}.</strong> Changes appear on {pagesUsingShell(state)} page{pagesUsingShell(state) === 1 ? '' : 's'}.
        </span>
      </div>
    );
  if (owner.kind === 'component')
    return (
      <div className="scope-note definition">
        <Component />
        <span>
          <strong>Component definition.</strong> Changes apply to every use of {def?.name ?? 'this component'}.
        </span>
      </div>
    );
  return (
    <div className="scope-note info">
      <Info />
      <span>
        <strong>This instance</strong> on {ownerLabel(state, owner)}. Other pages are not affected.
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
        badge={def.owner === 'project' ? <span className="badge violet">{def.kind === 'code' ? 'Code' : 'Project'}</span> : <span className="badge">Theme</span>}
      >
        <ScopeNote owner={owner} state={state} />
      </Header>
      {variants.length > 1 && (
        <Section title="Variant" id="variant">
          <select className="select" value={node.variant ?? def.defaultVariant} aria-label="Variant" onChange={(e) => void applyOps([{ type: 'instance.setVariant', owner, nodeId: node.id, variant: e.target.value }], 'Change variant')}>
            {variants.map(([id, v]) => (
              <option key={id} value={id}>
                {v.label}
              </option>
            ))}
          </select>
        </Section>
      )}
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
        <Section title="Style" id="style" defaultOpen={false}>
          <ScopePicker />
          <span className="field-hint">Styling the whole {def.name.toLowerCase()}. Select a part on the canvas or in Layers to style it.</span>
          <StyleControls
            styles={node.overrides?.root}
            inherited={inheritedStyles(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variant)}
            allowed={rootPart?.styleControls}
            tokens={tokens}
            onSet={onStyle('root')}
            onReset={() => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id }], 'Reset overrides')}
          />
          {partIds.length > 1 && (
            <div className="field-hint">
              Parts:{' '}
              {partIds
                .filter((p) => p !== 'root')
                .map((p, i) => (
                  <span key={p}>
                    {i > 0 && ', '}
                    <button className="btn-ghost" style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent-text)' }} onClick={() => setState({ selection: { owner, instancePath: [node.id], nodeId: def.parts[p].nodeId, partId: p } })}>
                      {def.parts[p].label}
                    </button>
                  </span>
                ))}
            </div>
          )}
        </Section>
      )}
      <Section title="Component" id="component" defaultOpen={false}>
        <p className="faint" style={{ margin: 0, fontSize: 12 }}>
          {def.description} Used {uses} time{uses === 1 ? '' : 's'} in this project.
        </p>
        <div className="action-grid">
          <button className="btn btn-sm" onClick={() => askAiAbout(selection)}>
            <Sparkles /> Ask AI
          </button>
          {def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => setState({ modal: { kind: 'edit-definition', ref: selection } })}>
              <Pencil /> Edit definition
            </button>
          )}
          <button className="btn btn-sm" onClick={() => void applyOps([{ type: 'component.makeUnique', owner, nodeId: node.id }], 'Make unique')} title="Copy the component for this placement only">
            <Split /> Make unique
          </button>
          {dev && def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => void applyOps([{ type: 'component.convertToCode', owner, nodeId: node.id }], 'Convert to code')} title="Create an editable Svelte copy">
              <Code /> Convert to code
            </button>
          )}
          {(dev || def.kind === 'code') && (
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
        <p className="mono faint" style={{ margin: 0, userSelect: 'text' }}>
          {node.id} · {def.id}
        </p>
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
  const listProp = Object.entries(def.properties).find(([, p]) => p.type === 'list' && bindings.some((b) => b.item && b.item in (p as { fields: object }).fields))?.[0];
  const instOwner = owner;
  const instNodeId = selection.instancePath[0];

  return (
    <>
      <Header title={part?.label ?? refLabel(state, selection)} icon={<span className="layer-kind part"><MousePointerClick /></span>} badge={<span className="badge violet">Part</span>}>
        <div className="scope-note info">
          <Info />
          <span>
            Part of{' '}
            <button style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent-text)', fontWeight: 600 }} onClick={() => setState({ selection: boundary })}>
              {def.name}
            </button>
            {owner.kind === 'shell' ? ` in the shared ${owner.id}` : ''}. Content changes affect this instance only.
          </span>
        </div>
      </Header>
      {nested ? (
        <Section title="Content" id="part-content">
          <p className="faint" style={{ margin: 0 }}>This element belongs to a nested component. Edit it from the definition with Edit definition, or make the outer component unique.</p>
        </Section>
      ) : bindings.length ? (
        <Section title="Content" id="part-content">
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
                <Field key={i} label={`${field.label} (${schema.itemLabel.toLowerCase()})`}>
                  <ScalarEditor schema={field} value={item[b.item!]} state={state} onChange={(v) => void applyOps([{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: listProp, itemId, field: b.item!, value: v }], `Edit ${field.label}`, `${instNodeId}:${listProp}:${itemId}:${b.item}`)} />
                </Field>
              );
            }
            return null;
          })}
          {listProp && !itemId && (
            <p className="faint" style={{ margin: 0, fontSize: 12 }}>
              This part repeats for every {(def.properties[listProp] as { itemLabel: string }).itemLabel.toLowerCase()}. Click one on the canvas to edit its text, or{' '}
              <button style={{ border: 0, background: 'none', padding: 0, color: 'var(--accent-text)' }} onClick={() => setState({ selection: boundary })}>
                edit them all
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
          <p className="faint" style={{ margin: 0 }}>This element is part of the component's design. Use Edit definition to change it for every use, or Make unique for this placement.</p>
        </Section>
      )}
      {part && !nested && def.kind === 'managed' && (
        <Section title="Style" id="part-style">
          <ScopePicker />
          <StyleControls
            styles={inst.overrides?.[partId!]}
            inherited={inheritedStyles(def, part.nodeId, inst.variant)}
            allowed={part.styleControls}
            tokens={tokens}
            onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, scope, property, value }], `Style ${part.label}`, `${instNodeId}:${partId}:${scope}:${property}`)}
            onReset={() => void applyOps([{ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId }], 'Reset part overrides')}
          />
          {listProp && <span className="field-hint">Part styles apply to every {(def.properties[listProp] as { itemLabel: string }).itemLabel.toLowerCase()} in this instance.</span>}
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
        <ScopePicker />
        <StyleControls
          styles={node.styles}
          inherited={undefined}
          allowed={styleSetFor(node)}
          tokens={tokens}
          onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value }], `Style ${property}`, `${node.id}:${scope}:${property}`)}
          onReset={() => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id }], 'Reset styles')}
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
    default:
      return undefined;
  }
}

function DefinitionNodeInspector({ state, def, node, tokens }: { state: ProjectState; def: ComponentDefinition; node: GraphNode; tokens: ReturnType<typeof effectiveTokens> }) {
  const scope = useStore((s) => s.styleScope);
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const uses = instancesOf(state, def.id).length;
  const partId = Object.entries(def.parts).find(([, p]) => p.nodeId === node.id)?.[0];
  return (
    <>
      <Header title={partId ? def.parts[partId].label : refLabel(state, { owner, instancePath: [], nodeId: node.id })} badge={<span className="badge violet">Definition</span>}>
        <div className="scope-note definition">
          <Component />
          <span>
            <strong>Editing {def.name}.</strong> Style changes apply to {uses === 1 ? 'its one use' : `all ${uses} uses`}, except where an instance overrides them.
          </span>
        </div>
      </Header>
      <Section title="Default style" id="def-style">
        <ScopePicker />
        <StyleControls
          styles={node.styles}
          inherited={undefined}
          tokens={tokens}
          allowed={styleSetFor(node)}
          onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value }], `Edit ${def.name} definition`, `${def.id}:${node.id}:${scope}:${property}`)}
          onReset={() => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id }], 'Reset definition styles')}
        />
      </Section>
      {node.kind === 'text' && !isBinding(node.text) && (
        <Section title="Fixed text" id="def-text">
          <DraftInput multiline value={Array.isArray(node.text) ? node.text.join('\n\n') : String(node.text)} onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'text', value: v }], 'Edit definition text')} />
        </Section>
      )}
    </>
  );
}

function PageSettings({ page, state }: { page: PageDoc; state: ProjectState }) {
  if (!page) return null;
  const upd = (patch: Record<string, unknown>, label = 'Update page settings') => void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], label);
  const isHome = page.id === state.site.homePageId;
  return (
    <div className="panel-body">
      <Header title={page.title} icon={<Globe size={16} className="faint" />} badge={isHome ? <span className="badge accent">Home</span> : undefined}>
        <span className="faint" style={{ fontSize: 12 }}>
          Page settings. Select something on the canvas to edit it.
        </span>
      </Header>
      <Section title="Page" id="page-basic">
        <Field label="Title">
          <DraftInput value={page.title} onCommit={(v) => v.trim() && upd({ title: v.trim() }, 'Rename page')} />
        </Field>
        <Field label="Address" hint={isHome ? 'The home page is always at /.' : 'Links to this page update automatically when you change it.'}>
          <DraftInput className="input mono" value={page.route} onCommit={(v) => upd({ route: v }, 'Change page address')} ariaLabel="Page address" />
        </Field>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="field-label">Show shared header and footer</span>
          <Switch checked={page.shell !== 'none'} onChange={(v) => upd({ shell: v ? 'default' : 'none' })} label="Show shared header and footer" />
        </div>
      </Section>
      <Section title="Search & sharing" id="page-seo">
        <Field label="Browser title" hint={`Default: ${isHome ? state.site.name : `${page.title} · ${state.site.name}`}`}>
          <DraftInput value={page.seo.title ?? ''} placeholder="Use default" onCommit={(v) => upd({ seoTitle: v })} />
        </Field>
        <Field label="Description" hint="Shown by search engines. About 150 characters.">
          <DraftInput multiline value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onCommit={(v) => upd({ description: v })} />
        </Field>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="field-label">Hide from search engines</span>
          <Switch checked={!!page.seo.noindex} onChange={(v) => upd({ noindex: v })} label="Hide from search engines" />
        </div>
      </Section>
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
      <div style={{ padding: 14 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => setState({ rightTab: 'styles' })}>
          <Link2 /> Site settings and styles
        </button>
      </div>
    </div>
  );
}

void RotateCcw;
