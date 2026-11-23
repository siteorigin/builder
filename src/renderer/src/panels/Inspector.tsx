import { useId, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowDown,
  ChevronDown,
  ChevronRight,
  Code,
  Component,
  Copy,
  Ellipsis,
  FileCode2,
  FileText,
  Heading,
  House,
  Image as ImageIcon,
  Link as LinkIcon,
  List,
  MousePointerClick,
  Palette,
  PanelBottom,
  PanelTop,
  Pencil,
  Pilcrow,
  Shapes,
  Sparkles,
  Split,
  SquareDashed,
  Trash2,
  Users
} from 'lucide-react';
import type { ComponentDefinition, ElementRef, GraphNode, InstanceNode, OwnerRef, PageDoc, ProjectState, ResponsiveStyles, StyleValue } from '@shared/types';
import { isBinding } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { effectiveTokens } from '@generator/index';
import { catalogueComponent } from '@catalogue/index';
import { codeTakesOverrides, enclosingRepeatProp, instancesOf } from '@engine/tree';
import { applyOps, setState, toast, useStore } from '../store';
import { DraftInput, Field, openSection, Section, SwitchRow, useMenu, type MenuItem } from '../components/ui';
import { FieldGroups, groupFields, ImageEditor, LinkEditor, PropField, ScalarField, IconPicker } from './PropEditors';
import { StyleControls } from './StyleControls';
import { ownerLabel, pagesUsingShell, refLabel, resolveRef } from '../lib/model';
import { askAiAbout, deleteSelection, duplicateSelection, structuralTarget } from '../lib/actions';

type ListOp = { kind: 'insert' } | { kind: 'remove'; itemId: string } | { kind: 'move'; itemId: string; index: number } | { kind: 'field'; itemId: string; field: string; value: unknown };
type Tokens = ReturnType<typeof effectiveTokens>;
type Tone = 'local' | 'shared' | 'definition';

/** Inspector sections are headings one level below the selection's name. */
const LEVEL = 4;

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

/** The selection one level up: the component a part belongs to (what Escape selects). */
function parentOf(sel: ElementRef): ElementRef {
  return { owner: sel.owner, instancePath: sel.instancePath.slice(0, -1), nodeId: sel.instancePath[sel.instancePath.length - 1] };
}

/**
 * Select a list's component, open its Content and land in that list: on one row (expanded when `expand`), or
 * on its Add button when the list is empty.
 */
function openList(parent: ElementRef, listProp: string, rowId: string | undefined, expand: boolean) {
  setState({ selection: parent });
  setTimeout(() => {
    openSection('content');
    setTimeout(() => {
      const list = document.querySelector<HTMLElement>(`#dock-panel-inspect [data-list="${CSS.escape(listProp)}"]`);
      const head = rowId ? list?.querySelector<HTMLElement>(`#list-head-${CSS.escape(rowId)}`) : null;
      if (head && expand && head.getAttribute('aria-expanded') !== 'true') head.click();
      (head ?? list?.querySelector<HTMLElement>('.insp-add'))?.focus({ preventScroll: false });
    }, 250);
  }, 50);
}

/** Number of style values set across sizes. */
function countStyles(styles: ResponsiveStyles | undefined): number {
  return Object.values(styles ?? {}).reduce((n, sc) => n + Object.keys(sc ?? {}).length, 0);
}
const changes = (n: number) => `${n} change${n === 1 ? '' : 's'}`;

/** The nearest repeat enclosing a node in a definition tree, if any. */
const enclosingRepeat = enclosingRepeatProp;

const focusName = () => requestAnimationFrame(() => requestAnimationFrame(() => document.querySelector<HTMLElement>('#dock-panel-inspect .insp-name h3')?.focus()));

/** Change the selection from inside the Inspector, then put focus on the new selection's name. */
function selectAndFocus(ref: ElementRef) {
  setState({ selection: ref });
  focusName();
}

/** Leave Edit everywhere for the page it was entered from; focus lands on that page's name, not the body. */
const doneEditing = () => {
  const dm = useStore.getState().definitionMode;
  if (!dm) return;
  setState({ definitionMode: null, pageId: dm.returnPageId, selection: null });
  focusName();
};

/** What kind of basic element a node is, in words and as an icon. */
function elementKind(node: GraphNode): { name: string; icon: ReactNode } {
  switch (node.kind) {
    case 'text':
      return node.tag === 'p' || node.rich ? { name: 'Paragraph', icon: <Pilcrow /> } : { name: 'Heading', icon: <Heading /> };
    case 'image':
      return { name: 'Image', icon: <ImageIcon /> };
    case 'link':
      return node.appearance === 'primary' || node.appearance === 'secondary' ? { name: 'Button', icon: <MousePointerClick /> } : { name: 'Link', icon: <LinkIcon /> };
    case 'icon':
      return { name: 'Icon', icon: <Shapes /> };
    case 'element':
      return { name: 'Container', icon: <SquareDashed /> };
    default:
      return { name: 'Element', icon: <SquareDashed /> };
  }
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
    const direct = !!selection && selection.owner.kind === 'component' && selection.owner.id === editingDef.id && !selection.instancePath.length;
    const node = direct ? editingDef.tree?.nodes[selection!.nodeId] : undefined;
    return (
      <div className="panel-body insp" key={selection ? JSON.stringify(selection) : 'def-overview'}>
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
  // Deeper inside the placement being edited (a component nested in it): stay in the design's own view.
  if (editingDef && throughPlacement && selection.instancePath.length > 1)
    return (
      <div className="panel-body insp" key={JSON.stringify(selection)}>
        <DefinitionOverview state={st} def={editingDef} nested />
      </div>
    );
  return (
    <div className="panel-body insp" key={JSON.stringify(selection)}>
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

/**
 * Sticky inspector header, the same anatomy for every selection: a kind tile, the name, what kind of thing it
 * is, then who a change affects. Commands for the selection sit at the right of the name.
 */
function Header({ title, kind, icon, tone = 'local', actions, children }: { title: string; kind: ReactNode; icon: ReactNode; tone?: Tone; actions?: ReactNode; children?: ReactNode }) {
  // The name takes focus (not a tab stop) when an Inspector link changes the selection, so focus stays here.
  return (
    <div className="insp-head insp-sel">
      <div className="insp-id">
        <span className={`insp-kind ${tone}`} aria-hidden="true">
          {icon}
        </span>
        <div className="insp-name">
          <h3 title={title} tabIndex={-1}>
            {title}
          </h3>
          <span className="insp-kind-label">{kind}</span>
        </div>
        {actions && <div className="insp-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/** One line saying who a change affects. Ordinary page-only edits stay quiet; shared and definition scopes keep their hue. */
function Scope({ tone, icon, children, aside }: { tone: Tone; icon: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className={`insp-scope ${tone}`}>
      {icon}
      <span className="grow">{children}</span>
      {aside}
    </div>
  );
}

function OwnerScope({ owner, state, aside }: { owner: OwnerRef; state: ProjectState; aside?: ReactNode }) {
  if (owner.kind === 'shell') {
    const n = pagesUsingShell(state);
    return (
      <Scope tone="shared" icon={<Users />} aside={aside}>
        <strong>Shared {owner.id}.</strong> Changes show on {n === 1 ? 'the 1 page' : `all ${n} pages`} that use it.
      </Scope>
    );
  }
  if (owner.kind === 'component')
    return (
      <Scope tone="definition" icon={<Pencil />}>
        <strong>Component design.</strong> Changes apply everywhere {state.components[owner.id]?.name ?? 'it'} is used.
      </Scope>
    );
  return (
    <Scope tone="local" icon={<FileText />} aside={aside}>
      Only on the {ownerLabel(state, owner)} page
    </Scope>
  );
}

/** A compact "Parts" menu: the way from a section down to one of its parts, beside the Style jump. */
function PartsButton({ title, parts }: { title: string; parts: Array<{ label: string; select: () => void }> }) {
  const menu = useMenu();
  return (
    <>
      <button className="insp-mini" aria-haspopup="menu" aria-expanded={menu.isOpen} title={`Select a part of ${title}`} onClick={(e) => menu.openAt(e.currentTarget, parts.map((p) => ({ label: p.label, onSelect: p.select })), `Parts of ${title}`)}>
        Parts <ChevronDown aria-hidden="true" />
      </button>
      {menu.node}
    </>
  );
}

/** Ask AI, plus a menu of everything else that can be done to the selection. */
function SelectionActions({ title, selection, items }: { title: string; selection: ElementRef; items: MenuItem[] }) {
  const menu = useMenu();
  return (
    <>
      <button className="icon-btn" aria-label={`Ask AI about ${title}`} title="Ask AI about this (⌘J)" onClick={() => askAiAbout(selection)}>
        <Sparkles />
      </button>
      {items.length > 0 && (
        <button className="icon-btn" aria-haspopup="menu" aria-expanded={menu.isOpen} aria-label={`More actions for ${title}`} title="More actions" onClick={(e) => menu.openAt(e.currentTarget, items, `Actions for ${title}`)}>
          <Ellipsis />
        </button>
      )}
      {menu.node}
    </>
  );
}

function InstanceInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: InstanceNode; tokens: Tokens; selection: ElementRef }) {
  const scope = useStore((s) => s.styleScope);
  const dev = useStore((s) => !!s.settings?.developerMode);
  // Which declared part of a code component the Style section edits.
  const [codePart, setCodePart] = useState('root');
  const def = state.components[node.definitionId];
  if (!def) return null;
  const title = node.name ?? def.name;
  const shell = owner.kind === 'shell';
  const variants = Object.entries(def.variants ?? {});
  const uses = instancesOf(state, def.id).length;
  const partIds = def.kind === 'managed' ? Object.keys(def.parts).filter((p) => p !== 'root') : [];
  const rootPart = def.parts.root;
  // A code component takes style changes only when it places the classes it is given.
  const codeStyled = def.kind === 'code' && codeTakesOverrides(def);
  const styledPart = def.kind === 'code' && def.parts[codePart] ? codePart : 'root';
  // Hiding a section at some sizes is always offered, whatever else its design lets change.
  const withHidden = (controls: string[] | undefined) => (controls ? [...new Set([...controls, 'hidden'])] : codeStyled ? ['paddingBlock', 'background', 'color', 'border', 'radius', 'shadow', 'opacity', 'hidden'] : undefined);
  // Making a code component unique copies its source into the project, which is only editable in developer mode.
  const canMakeUnique = def.kind === 'managed' || dev;
  const origin = def.owner === 'project' ? (def.kind === 'code' ? 'Code component' : 'Your component') : 'From the theme';
  const set = (prop: string, value: unknown) => void applyOps([{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }], `Edit ${def.properties[prop]?.label ?? prop}`, `${node.id}:${prop}`);
  const onStyle = (partId: string) => (property: string, value: StyleValue | null) =>
    void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId, scope, property, value }], `Style ${def.parts[partId]?.label ?? partId}`, `${node.id}:${partId}:${scope}:${property}`);
  const overrides = countStyles(node.overrides?.[styledPart]);
  const selectPart = (p: string) => selectAndFocus({ owner, instancePath: [node.id], nodeId: def.parts[p].nodeId, partId: p });
  const editEverywhere = () => setState({ modal: { kind: 'edit-definition', ref: selection } });
  const makeUnique = () => void applyOps([{ type: 'component.makeUnique', owner, nodeId: node.id }], 'Make unique');
  const viewSource = () => setState({ modal: { kind: 'source', definitionId: def.id } });
  // The copy's structure is now edited in source, so offer to open it straight away.
  const convertToCode = async () => {
    const r = await applyOps([{ type: 'component.convertToCode', owner, nodeId: node.id }], 'Convert to code');
    const id = r?.[0]?.definitionId as string | undefined;
    if (id) toast('Converted to a code component. Its properties stay editable here.', 'info', { label: 'Open code', run: () => setState({ modal: { kind: 'source', definitionId: id } }) });
  };
  const items: MenuItem[] = [
    ...(def.kind === 'managed' ? [{ label: 'Edit everywhere…', icon: <Pencil />, onSelect: editEverywhere }] : []),
    ...(canMakeUnique ? [{ label: 'Make unique', icon: <Split />, hint: 'Separate copy', onSelect: makeUnique }] : []),
    ...(dev && def.kind === 'managed' ? [{ label: 'Convert to code', icon: <Code />, onSelect: () => void convertToCode() }] : []),
    ...(dev ? [{ label: def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source', icon: <FileCode2 />, onSelect: viewSource }] : []),
    ...(partIds.length ? [{ separator: true }, { heading: 'Select a part' }, ...partIds.map((p) => ({ label: def.parts[p].label, onSelect: () => selectPart(p) }))] : []),
    ...(!shell
      ? [
          { separator: true },
          { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
          { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
        ]
      : [])
  ];
  const fields = groupFields(Object.entries(def.properties).map(([key, schema]) => ({ key, schema, data: null })));
  return (
    <>
      <Header
        title={title}
        kind={shell ? `Shared ${owner.id} · ${origin.toLowerCase()}` : `Section · ${origin.toLowerCase()}`}
        tone={shell ? 'shared' : 'local'}
        icon={shell ? owner.id === 'footer' ? <PanelBottom /> : <PanelTop /> : <Component />}
        actions={<SelectionActions title={title} selection={selection} items={items} />}
      >
        <OwnerScope
          owner={owner}
          state={state}
          aside={
            !shell &&
            def.kind === 'managed' && (
              <span className="insp-mini-row">
                {partIds.length > 0 && <PartsButton title={title} parts={partIds.map((p) => ({ label: def.parts[p].label, select: () => selectPart(p) }))} />}
                <button className="insp-mini" onClick={() => openSection('style')} title="Open Style and scroll to it">
                  Style <ArrowDown aria-hidden="true" />
                </button>
              </span>
            )
          }
        />
      </Header>
      <Section title="Content" id="content" level={LEVEL}>
        {fields.length === 0 && <p className="faint insp-note">This section has no content of its own. Add elements inside it from Insert.</p>}
        <FieldGroups
          groups={fields}
          render={({ key, schema, label }) => (
            <PropField
              key={key}
              name={key}
              schema={schema}
              label={label}
              value={node.props[key] ?? schema.default}
              onChange={(v) => set(key, v)}
              onList={(op) => void applyOps([listOps(owner, node.id, key, op)], `Edit ${schema.label}`, op.kind === 'field' ? `${node.id}:${key}:${op.itemId}:${op.field}` : undefined)}
              state={state}
            />
          )}
        />
      </Section>
      {def.kind === 'managed' && (
        <Section title="Style" id="style" defaultOpen={false} level={LEVEL} scope={overrides ? `Whole section · ${changes(overrides)}` : 'Whole section'}>
          {partIds.length > 0 && (
            <p className="insp-note insp-parts">
              <span className="faint">To style one part, select it:</span>{' '}
              {partIds.map((p, i) => (
                <span key={p}>
                  {i > 0 && <span className="faint"> · </span>}
                  <button className="link-btn" onClick={() => selectPart(p)}>
                    {def.parts[p].label}
                  </button>
                </span>
              ))}
            </p>
          )}
          {variants.length > 1 && (
            <Field label="Design variant">
              <select className="select" value={node.variant ?? def.defaultVariant} onChange={(e) => void applyOps([{ type: 'instance.setVariant', owner, nodeId: node.id, variant: e.target.value }], 'Change variant')}>
                {variants.map(([id, v]) => (
                  <option key={id} value={id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <StyleControls
            styles={node.overrides?.root}
            inherited={inheritedStyles(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variant)}
            allowed={withHidden(rootPart?.styleControls)}
            tokens={tokens}
            onSet={onStyle('root')}
            onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, partId: 'root', scope: sc }], 'Reset overrides')}
            target={`the ${def.name.toLowerCase()} itself`}
          />
        </Section>
      )}
      {codeStyled && (
        <Section title="Style" id="style" defaultOpen={false} level={LEVEL} scope={overrides ? `${def.parts[styledPart]?.label ?? 'Whole section'} · ${changes(overrides)}` : undefined}>
          {Object.keys(def.parts).length > 1 && (
            <Field label="Part">
              <select className="select" value={styledPart} onChange={(e) => setCodePart(e.target.value)}>
                {Object.entries(def.parts).map(([id, p]) => (
                  <option key={id} value={id}>
                    {id === 'root' ? `Whole ${def.name.toLowerCase()}` : p.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <StyleControls
            key={styledPart}
            styles={node.overrides?.[styledPart]}
            inherited={undefined}
            allowed={withHidden(def.parts[styledPart]?.styleControls)}
            tokens={tokens}
            onSet={onStyle(styledPart)}
            onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, partId: styledPart, scope: sc }], 'Reset overrides')}
            target={styledPart === 'root' ? `the ${def.name.toLowerCase()} itself` : `the ${def.parts[styledPart].label.toLowerCase()}`}
          />
        </Section>
      )}
      <Section title="Component" id="component" defaultOpen={false} level={LEVEL} scope={shell ? undefined : `Used ${uses === 1 ? 'once' : `${uses} times`}`}>
        <p className="insp-note muted">
          {def.description ? `${def.description} ` : ''}
          <span className="faint">{def.owner === 'project' ? (def.kind === 'code' ? 'A code component in this project.' : 'Made in this project.') : 'From the site’s theme.'}</span>
        </p>
        <div className="action-grid">
          {def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={editEverywhere}>
              <Pencil /> Edit everywhere…
            </button>
          )}
          {canMakeUnique && (
            <button className="btn btn-sm" onClick={makeUnique} title="Make a separate copy of this component for this placement, so its design can change on its own">
              <Split /> Make unique
            </button>
          )}
          {dev && def.kind === 'managed' && (
            <button className="btn btn-sm" onClick={() => void convertToCode()} title="Create an editable Svelte copy">
              <Code /> Convert to code
            </button>
          )}
          {dev && (
            <button className="btn btn-sm" onClick={viewSource}>
              <FileCode2 /> {def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source'}
            </button>
          )}
        </div>
      </Section>
      <Section title="Advanced" id="advanced" defaultOpen={false} level={LEVEL} scope={node.anchor ? `#${node.anchor}` : undefined}>
        <Field label="Layer name" hint="Shown in Layers. Not visible on the site.">
          <DraftInput value={node.name ?? ''} placeholder={def.name} onCommit={(v) => void applyOps([{ type: 'node.rename', owner, nodeId: node.id, name: v }], 'Rename layer')} />
        </Field>
        {def.kind === 'managed' && (
          <Field label="Anchor ID" hint={`Lets links jump straight to this ${shell ? 'part of every page' : 'section'}, as #${node.anchor || 'pricing'}. Choose it in a link’s Section.`}>
            <DraftInput value={node.anchor ?? ''} placeholder="e.g. pricing" onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'anchor', value: v.trim() }], 'Set anchor')} />
          </Field>
        )}
        {dev && (
          <p className="mono faint insp-note" style={{ userSelect: 'text' }}>
            {node.id} · {def.id}
          </p>
        )}
      </Section>
    </>
  );
}

function PartInspector({ state, selection, tokens }: { state: ProjectState; selection: ElementRef; tokens: Tokens }) {
  const scope = useStore((s) => s.styleScope);
  const r = resolveRef(state, selection);
  const def = r.def!;
  const inst = r.instance!;
  const node = r.node!;
  const nested = selection.instancePath.length > 1;
  const owner = selection.owner;
  const partId = selection.partId;
  const part = partId ? def.parts[partId] : undefined;
  const parent = parentOf(selection);
  const itemId = selection.itemPath?.[selection.itemPath.length - 1];
  const title = part?.label ?? refLabel(state, selection);

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
  const repeatList = enclosingRepeatProp(def, node.id);
  // The repeat that encloses the part names its list exactly; a field-name match is only a fallback.
  const listProp = (repeatList && def.properties[repeatList]?.type === 'list' ? repeatList : undefined) ?? contentList;
  const listSchema = listProp ? (def.properties[listProp] as Extract<ComponentDefinition['properties'][string], { type: 'list' }>) : undefined;
  const listItems = listProp ? (((inst.props[listProp] ?? listSchema?.default) as Array<Record<string, unknown>>) ?? []) : [];
  const itemLabel = listSchema?.itemLabel.toLowerCase() ?? 'item';
  const listLabel = listSchema?.label.toLowerCase() ?? 'items';
  const itemIndex = itemId ? listItems.findIndex((x) => x.id === itemId) : -1;
  const partName = (part?.label ?? 'part').toLowerCase();
  const n = listItems.length;
  // Style reach, worded the same in the header and on the Style heading.
  const styleReach = n === 1 ? `the 1 ${partName}` : `all ${n} ${partName}s`;
  const instOwner = owner;
  const instNodeId = selection.instancePath[0];
  const kind = elementKind(node);
  const parentName = inst.name ?? def.name;
  const parentLink = (
    <>
      Part of{' '}
      <button className="link-btn" onClick={() => selectAndFocus(parent)} title="Select the whole section (Esc)">
        {parentName}
      </button>
    </>
  );
  const hasContent = !nested && bindings.length > 0;
  // Content reach comes from the binding: an item field is per item, a section property is shared by every item.
  const perItem = bindings.some((b) => b.item);
  const contentReach = !hasContent || !listSchema ? '' : perItem ? (itemId ? `This ${itemLabel} only${itemIndex >= 0 ? ` (${itemIndex + 1} of ${n})` : ''}` : `Each ${itemLabel} has its own`) : `Same in every ${itemLabel}`;

  return (
    <>
      <Header
        title={title}
        kind={parentLink}
        tone={owner.kind === 'shell' ? 'shared' : 'local'}
        icon={kind.icon}
        actions={<SelectionActions title={title} selection={selection} items={[{ label: `Select ${parentName}`, icon: <Component />, shortcut: 'Esc', onSelect: () => selectAndFocus(parent) }]} />}
      >
        <OwnerScope owner={owner} state={state} />
        {listSchema && !nested && (
          <Scope tone="local" icon={<List />}>
            {contentReach ? `Content: ${contentReach.charAt(0).toLowerCase()}${contentReach.slice(1)} · ` : ''}Style: {styleReach}
          </Scope>
        )}
      </Header>
      {nested ? (
        <Section title="Content" id="part-content" level={LEVEL}>
          <p className="muted insp-note">This belongs to a component inside {def.name}. Change it with Edit everywhere on that component, or make {def.name} unique.</p>
        </Section>
      ) : bindings.length ? (
        <Section title="Content" id="part-content" level={LEVEL} scope={listSchema ? (perItem ? (itemId ? `This ${itemLabel} only` : `Each ${itemLabel}`) : `Every ${itemLabel}`) : undefined}>
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
            if (listProp && listSchema && itemId) {
              const field = listSchema.fields[b.item!];
              const item = listItems.find((x) => x.id === itemId);
              if (!field || !item) return null;
              const edit = (v: unknown) => void applyOps([{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: listProp, itemId, field: b.item!, value: v }], `Edit ${field.label}`, `${instNodeId}:${listProp}:${itemId}:${b.item}`);
              return <ScalarField key={i} schema={field} value={item[b.item!]} state={state} onChange={edit} />;
            }
            return null;
          })}
          {listSchema && perItem && !itemId && <p className="muted insp-note">Each {itemLabel} has its own text. Click one on the page to change it, or open the list to edit them all.</p>}
          {listSchema && (
            <button className="btn btn-sm insp-inline-btn" onClick={() => openList(parent, listProp!, itemId ?? (listItems[0]?.id as string | undefined), !!itemId)}>
              <List /> {itemId ? `Show in ${listLabel} list` : `Open ${listLabel} list`}
            </button>
          )}
        </Section>
      ) : (
        <Section title="Content" id="part-content" level={LEVEL}>
          <p className="muted insp-note">This is fixed in the section’s design. To change it, select {def.name} and choose Edit everywhere, or Make unique for just this placement.</p>
        </Section>
      )}
      {part && !nested && def.kind === 'managed' && (
        <Section title="Style" id="part-style" level={LEVEL} scope={[listSchema ? styleReach.charAt(0).toUpperCase() + styleReach.slice(1) : '', countStyles(inst.overrides?.[partId!]) ? changes(countStyles(inst.overrides?.[partId!])) : ''].filter(Boolean).join(' · ') || undefined}>
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

function PrimitiveInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: GraphNode; tokens: Tokens; selection: ElementRef }) {
  const scope = useStore((s) => s.styleScope);
  const content = (field: Extract<EditOperation, { type: 'node.setContent' }>['field'], value: unknown) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field, value }], `Edit ${field}`, `${node.id}:${field}`);
  const t = structuralTarget(selection);
  const title = refLabel(state, selection);
  const kind = elementKind(node);
  const iconId = useId();
  const items: MenuItem[] =
    t && owner.kind !== 'shell'
      ? [
          ...(node.kind === 'element' ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component', ref: t } }) }, { separator: true }] : []),
          { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
          { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
        ]
      : [];
  return (
    <>
      <Header title={title} kind={title.toLowerCase().startsWith(kind.name.toLowerCase()) ? 'Basic element' : `${kind.name} · basic element`} tone={owner.kind === 'shell' ? 'shared' : owner.kind === 'component' ? 'definition' : 'local'} icon={kind.icon} actions={<SelectionActions title={title} selection={selection} items={items} />}>
        <OwnerScope owner={owner} state={state} />
      </Header>
      <Section title="Content" id="prim-content" level={LEVEL}>
        {node.kind === 'text' && (
          <>
            {!node.rich && (
              <Field label="Type">
                <select className="select" value={node.tag} onChange={(e) => content('tag', e.target.value)}>
                  {['h1', 'h2', 'h3', 'h4', 'p'].map((tg) => (
                    <option key={tg} value={tg}>
                      {tg === 'p' ? 'Paragraph' : `Heading ${tg.slice(1)}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Text" hint="Or double-click the text on the page to edit it there.">
              <DraftInput multiline rows={2} value={Array.isArray(node.text) ? node.text.join('\n\n') : isBinding(node.text) ? '' : String(node.text)} onCommit={(v) => content('text', v)} />
            </Field>
          </>
        )}
        {node.kind === 'image' && !isBinding(node.image) && (
          <div className="field" role="group" aria-label="Image">
            <ImageEditor value={node.image} onChange={(v) => content('image', v)} state={state} />
          </div>
        )}
        {node.kind === 'link' && (
          <>
            <Field label="Label">
              <DraftInput value={isBinding(node.label) ? '' : String(node.label)} onCommit={(v) => content('label', v)} />
            </Field>
            {!isBinding(node.link) && (
              <div className="field" role="group" aria-labelledby={`${node.id}-dest`}>
                <div className="field-label" id={`${node.id}-dest`}>
                  Link
                </div>
                <LinkEditor value={node.link} onChange={(v) => content('link', v)} state={state} label={kind.name} />
              </div>
            )}
            <Field label="Appearance">
              <select className="select" value={String(node.appearance)} onChange={(e) => content('appearance', e.target.value)}>
                <option value="primary">Primary button</option>
                <option value="secondary">Secondary button</option>
                <option value="text">Text with arrow</option>
                <option value="link">Underlined link</option>
              </select>
            </Field>
          </>
        )}
        {node.kind === 'icon' && (
          <Field label="Icon" controlId={iconId}>
            <IconPicker id={iconId} value={isBinding(node.icon) ? 'sparkles' : String(node.icon)} onChange={(v) => content('icon', v)} />
          </Field>
        )}
        {node.kind === 'element' && <p className="faint insp-note">A container with {node.children.length} item{node.children.length === 1 ? '' : 's'}. With it selected, add elements inside it from Insert.</p>}
      </Section>
      <Section title="Style" id="prim-style" level={LEVEL} scope={countStyles(node.styles) ? changes(countStyles(node.styles)) : undefined}>
        <StyleControls
          styles={node.styles}
          inherited={undefined}
          allowed={styleSetFor(node)}
          tokens={tokens}
          onSet={(property, value) => void applyOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value }], `Style ${property}`, `${node.id}:${scope}:${property}`)}
          onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, scope: sc }], 'Reset styles')}
        />
      </Section>
      <Section title="Advanced" id="prim-advanced" defaultOpen={false} level={LEVEL} scope={node.anchor ? `#${node.anchor}` : undefined}>
        <Field label="Anchor ID" hint="Lets links jump straight to this element, as #services.">
          <DraftInput value={node.anchor ?? ''} placeholder="e.g. services" onCommit={(v) => content('anchor', v)} />
        </Field>
      </Section>
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

/** Where a component is used, in words: "Home and About", "Home, About and 3 more". */
function placesText(state: ProjectState, def: ComponentDefinition): string {
  const places = [...new Set(instancesOf(state, def.id).map((u) => u.label))];
  if (!places.length) return 'nowhere yet';
  if (places.length === 1) return places[0];
  if (places.length <= 3) return `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}`;
  return `${places.slice(0, 2).join(', ')} and ${places.length - 2} more`;
}

const DoneButton = () => (
  <button className="btn btn-sm" onClick={doneEditing}>
    Done editing
  </button>
);

/** Component editing with nothing selected: what is being edited, where it is used, and how to start. */
function DefinitionOverview({ state, def, nested }: { state: ProjectState; def: ComponentDefinition; nested?: boolean }) {
  return (
    <>
      <Header title={def.name} kind="Component design" tone="definition" icon={<Component />} actions={<DoneButton />}>
        <Scope tone="definition" icon={<Pencil />}>
          <strong>Editing everywhere.</strong> Changes apply wherever it’s used: {placesText(state, def)}.
        </Scope>
      </Header>
      <div className="insp-empty">
        <MousePointerClick aria-hidden="true" />
        <p>{nested ? `That belongs to a component inside ${def.name}, so it can’t be changed here. ` : ''}Click part of {def.name} on the page, or choose a part:</p>
        <div className="insp-part-list" role="group" aria-label={`Parts of ${def.name}`}>
          {def.tree?.rootIds[0] && (
            <button className="btn btn-sm" onClick={() => selectAndFocus({ owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: def.tree!.rootIds[0] })}>
              Whole {def.name.toLowerCase()}
            </button>
          )}
          {Object.entries(def.parts)
            .filter(([id]) => id !== 'root')
            .map(([id, p]) => (
              <button key={id} className="btn btn-sm" onClick={() => selectAndFocus({ owner: { kind: 'component', id: def.id }, instancePath: [], nodeId: p.nodeId, partId: id })}>
                {p.label}
              </button>
            ))}
        </div>
      </div>
    </>
  );
}

function DefinitionNodeInspector({ state, def, node, tokens }: { state: ProjectState; def: ComponentDefinition; node: GraphNode; tokens: Tokens }) {
  const scope = useStore((s) => s.styleScope);
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const uses = instancesOf(state, def.id).length;
  const partId = Object.entries(def.parts).find(([, p]) => p.nodeId === node.id)?.[0];
  const isRoot = def.tree?.rootIds[0] === node.id;
  const title = partId && partId !== 'root' ? def.parts[partId].label : isRoot ? def.name : refLabel(state, { owner, instancePath: [], nodeId: node.id });
  // A copy of a theme component compares against the theme's design, so only real changes show as changes.
  const original = def.componentId ? catalogueComponent(state.site.themeId, def.componentId)?.tree?.nodes[node.id]?.styles : undefined;
  const changed: ResponsiveStyles | undefined = original
    ? Object.fromEntries(
        Object.entries(node.styles ?? {})
          .map(([sc, vals]) => [sc, Object.fromEntries(Object.entries(vals ?? {}).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((original as ResponsiveStyles)[sc as keyof ResponsiveStyles]?.[k])))])
          .filter(([, vals]) => Object.keys(vals as object).length)
      )
    : node.styles;
  // A part inside a repeat is styled once for every item, in every placement.
  const repeated = enclosingRepeat(def, node.id);
  const itemWord = repeated ? (def.properties[repeated] as { itemLabel?: string } | undefined)?.itemLabel?.toLowerCase() : undefined;
  const placements = uses === 1 ? '1 placement' : `${uses} placements`;
  const rootRef: ElementRef | null = def.tree?.rootIds[0] ? { owner, instancePath: [], nodeId: def.tree.rootIds[0] } : null;
  const kindLine = isRoot ? (
    'Component design'
  ) : (
    <>
      Part of{' '}
      {rootRef ? (
        <button className="link-btn" onClick={() => selectAndFocus(rootRef)} title="Select the whole design (Esc)">
          {def.name}
        </button>
      ) : (
        def.name
      )}{' '}
      design
    </>
  );
  return (
    <>
      <Header title={title} kind={kindLine} tone="definition" icon={isRoot ? <Component /> : elementKind(node).icon} actions={<DoneButton />}>
        <Scope tone="definition" icon={<Pencil />}>
          <strong>Editing everywhere.</strong>{' '}
          {uses === 1 ? `Used once, on ${placesText(state, def)}, and wherever you add it later. A placement’s own changes still win.` : `Changes apply to all ${uses} placements, except where one has its own changes.`}
        </Scope>
      </Header>
      {node.kind === 'text' && !isBinding(node.text) && (
        <Section title="Content" id="def-text" level={LEVEL} scope="Same in every placement">
          <Field label="Text">
            <DraftInput multiline rows={2} value={Array.isArray(node.text) ? node.text.join('\n\n') : String(node.text)} onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'text', value: v }], 'Edit definition text')} />
          </Field>
        </Section>
      )}
      {/* A button's own label (not one each placement fills in), as the canvas edits it in place. */}
      {node.kind === 'link' && !isBinding(node.label) && (
        <Section title="Content" id="def-label" level={LEVEL} scope="Same in every placement">
          <Field label="Button text">
            <DraftInput value={String(node.label)} onCommit={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'label', value: v }], 'Edit button text everywhere')} />
          </Field>
        </Section>
      )}
      <Section title="Style" id="def-style" level={LEVEL} scope={repeated ? `Every ${itemWord ?? 'item'} · ${placements}` : placements}>
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
  const dev = useStore((s) => !!s.settings?.developerMode);
  const [titleError, setTitleError] = useState<string | null>(null);
  if (!page) return null;
  const upd = (patch: Record<string, unknown>, label = 'Update page settings') => void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], label);
  const isHome = page.id === state.site.homePageId;
  return (
    <div className="panel-body insp">
      <Header title={page.title} kind={`${isHome ? 'Home page' : 'Page'} · ${isHome ? '/' : page.route}`} icon={isHome ? <House /> : <FileText />}>
        <Scope tone="local" icon={<MousePointerClick />}>
          {previewing ? 'Previewing. Page settings stay editable; switch to Edit to select things on the page.' : 'Nothing selected. Click anything on the page to edit it.'}
        </Scope>
      </Header>
      <Section title="Page" id="page-basic" level={LEVEL}>
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
      <Section title="Search & sharing" id="page-seo" level={LEVEL}>
        <Field label="Browser title" hint={`Leave empty to use “${isHome ? state.site.name : `${page.title} · ${state.site.name}`}”.`}>
          <DraftInput value={page.seo.title ?? ''} onCommit={(v) => upd({ seoTitle: v })} />
        </Field>
        <Field label="Description" hint="Shown by search engines. About 150 characters.">
          <DraftInput multiline value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onCommit={(v) => upd({ description: v })} />
        </Field>
        <SwitchRow checked={!!page.seo.noindex} onChange={(v) => upd({ noindex: v })} label="Hide from search engines" hint="Search engines are asked not to list this page." />
      </Section>
      {dev && (
        <Section title="Advanced" id="page-adv" defaultOpen={false} level={LEVEL}>
          <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setState({ modal: { kind: 'page-source', pageId: page.id } })}>
            <FileCode2 /> View generated source
          </button>
          <p className="mono faint insp-note" style={{ userSelect: 'text' }}>
            {page.id}
          </p>
        </Section>
      )}
      <button className="insp-goto" onClick={() => setState({ rightTab: 'styles' })}>
        <span className="insp-kind local" aria-hidden="true">
          <Palette />
        </span>
        <span className="grow">
          <strong>Site styles</strong>
          <span>Colors, fonts and spacing for every page</span>
        </span>
        <ChevronRight aria-hidden="true" className="chev" />
      </button>
    </div>
  );
}
