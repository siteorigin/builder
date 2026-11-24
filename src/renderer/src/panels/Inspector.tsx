import { axesOf, designStyles, selectedVariants, selectedVariantStyles } from '@shared/variants';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
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
import type { ComponentDefinition, ElementRef, GraphNode, ImageValue, InstanceNode, LinkValue, ListItem, ListProp, OwnerRef, PageDoc, ProjectState, PropSchema, ResponsiveStyles, ScalarPropSchema, StyleValue } from '@shared/types';
import { isBinding } from '@shared/types';
import { assetLabels, sortAssets } from '@shared/asset-order';
import { showsPart } from '@shared/page-shell';
import { videoFieldNotes, type VideoFieldNotes } from '@shared/video';
import { cascadeStyles, partStyleControls, placementStyleControls, styleSetFor } from '@shared/styles';
import { richTextToMarkdown, toRichText } from '@shared/richtext';
import type { EditOperation } from '@shared/ops';
import { effectiveTokens, isDraftPage } from '@generator/index';
import type { UnlinkedButton } from '@generator/checks';
import { catalogueComponent } from '@catalogue/index';
import { formFieldSettingsHidden, formFieldsAsSent, formKeyNote, formServiceSetup, namesFormFields, offersFormChoices, type FormServiceSetup } from '@catalogue/foundation/form';
import { codeTakesOverrides, enclosingRepeatProp, instancesOf, itemLinkPairs } from '@engine/tree';
import type { TableEdit } from '@engine/table';
import { applyOps, applyWith, commitOps, getState, setState, toast, useStore, type InspectorFocus, type PendingEdit } from '../store';
import { DraftInput, Field, openSection, Section, Segmented, SwitchRow, useMenu, type MenuItem } from '../components/ui';
import { itemStylesOf, liveItemStyles, repeatedPartList } from '@shared/item-styles';
import { ContactMismatch, FieldGroups, groupFields, ImageEditor, LinkEditor, PropField, ScalarField, IconPicker, useRevealedItem, type ListItemNote, type ListOp } from './PropEditors';
import { StyleControls } from './StyleControls';
import { useStyleCopyItems } from './StylePaste';
import type { FocusImage } from './FocusEditor';
import { assetUrl, definitionView, listPropFor, ownerLabel, placementsOn, refLabel, resolveRef, shellPageNames, shellReach, shownValue, throughPlacement, treeFor } from '../lib/model';
import { askAiAbout, deleteSelection, duplicateSelection, structuralTarget } from '../lib/actions';
import { hideAt, hideButtonOp, unlinkedAt, unlinkedField, unlinkedNote } from '../lib/unlinked';
import { teaserFieldNote } from '../lib/page-teasers';
import { defaultReach, designContent, designContentOp, forwardedProp, propDefaultOp, reachText, type ContentField, type DesignContent } from '../lib/design-content';

type Tokens = ReturnType<typeof effectiveTokens>;
type Tone = 'local' | 'shared' | 'definition';

/** Inspector sections are headings one level below the selection's name. */
const LEVEL = 4;

/** Under each contact form field's name: the key its answer is sent under, or the other fields sent under it too. */
function formKeyNotes(def: ComponentDefinition, value: unknown): ((item: ListItem, index: number) => ListItemNote | undefined) | undefined {
  if (value !== undefined && !Array.isArray(value)) return undefined;
  const fields = formFieldsAsSent(def, value);
  return (_item, i) => ({ field: 'name', ...formKeyNote(fields, i) });
}

/** Under a contact form's service setting: what the form still needs, then how to get it from the service. */
function formServiceHint(service: FormServiceSetup): ReactNode {
  return (
    <>
      {service.problem && <span className="field-warning">{service.problem}</span>}
      {service.setup}
    </>
  );
}

/** A video field's hint, when it has one. */
const videoHint = (note: VideoFieldNotes['url'] | VideoFieldNotes['title'] | undefined) => (note && 'hint' in note ? note.hint : undefined);

function listOps(owner: OwnerRef, nodeId: string, prop: string, op: ListOp): EditOperation {
  switch (op.kind) {
    case 'insert':
      return { type: 'instance.listInsert', owner, nodeId, prop, ...(op.item ? { item: op.item } : {}) };
    case 'remove':
      return { type: 'instance.listRemove', owner, nodeId, prop, itemId: op.itemId };
    case 'move':
      return { type: 'instance.listMove', owner, nodeId, prop, itemId: op.itemId, index: op.index };
    case 'field':
    case 'repair':
      return { type: 'instance.setProp', owner, nodeId, prop, itemId: op.itemId, field: op.field, value: op.value };
  }
}

/**
 * Apply a list edit. A field edit joins the same field's last edit (`coalesceKey`); a repair the inspector offered
 * is its own undo step under its own name, on the project revision it was planned against.
 */
/**
 * A placement's value for a property as the project holds it now, with that revision: read when an edit is built,
 * after the edits before it have landed, rather than as the panel last rendered it.
 */
function readProp(owner: OwnerRef, nodeId: string, prop: string): { value: unknown; revision: number } | undefined {
  const snap = getState().snapshot;
  const node = snap ? treeFor(snap.state, owner)?.nodes[nodeId] : undefined;
  if (!snap || node?.kind !== 'instance') return undefined;
  const schema = snap.state.components[node.definitionId]?.properties[prop];
  return { value: node.props[prop] ?? schema?.default, revision: snap.revision };
}

function applyListOp(owner: OwnerRef, nodeId: string, prop: string, op: ListOp, label: string, coalesceKey?: string) {
  if (op.kind === 'repair') return applyOps([listOps(owner, nodeId, prop, op)], op.label, undefined, op.revision);
  return applyWith(op.kind === 'field' ? op.edit : undefined, [listOps(owner, nodeId, prop, op)], label, op.kind === 'field' ? coalesceKey : undefined);
}

/**
 * Apply one table edit by row and column ID. Typing in one cell (or one column's name) joins that cell's last edit;
 * adding, removing and moving rows or columns are each their own undo step.
 */
function applyTableEdit(owner: OwnerRef, nodeId: string, prop: string, edit: TableEdit, label: string): Promise<boolean> {
  const at = `${owner.kind}:${owner.id}:${nodeId}:${prop}`;
  const coalesceKey = edit.action === 'setCell' ? `${at}:${edit.rowId}:${edit.columnId}` : edit.action === 'renameColumn' ? `${at}:column:${edit.columnId}` : undefined;
  return applyOps([{ type: 'instance.editTable', owner, nodeId, prop, ...edit }], label, coalesceKey).then((r) => r !== null);
}


/**
 * A style edit's history key: changes to one property in a row merge into one Undo step. A focal point is the
 * exception: each drag, typed value or Center is its own step, so Undo goes back one drag at a time.
 */
const styleKey = (property: string, key: string) => (property === 'objectPosition' ? undefined : key);

/** Where the preview serves pictures from, once it is running. */
const useDevUrl = () => useStore((s) => (s.runtime.state === 'ready' ? s.runtime.url : null));

/**
 * An image as the page shows it (`shownValue`), and for a repeated item stored without that field, the field's
 * default, as the site shows it. Undefined when it can't be told.
 */
function shownImage(state: ProjectState, ref: ElementRef, bound: unknown): unknown {
  const v = shownValue(state, ref, bound);
  if (v !== undefined || !isBinding(bound) || !('$item' in bound)) return v;
  const r = resolveRef(state, ref);
  const list = r.def ? listPropFor(r.def, ref.nodeId) : undefined;
  const schema = list ? r.def!.properties[list] : undefined;
  if (schema?.type !== 'list') return undefined;
  const props = (r.instance?.props ?? {}) as Record<string, unknown>;
  const items = Object.hasOwn(props, list!) ? props[list!] : schema.default;
  const itemId = ref.itemPath?.[ref.itemPath.length - 1];
  const item = Array.isArray(items) ? (items.find((it) => (it as { id?: unknown } | null)?.id === itemId) as Record<string, unknown> | undefined) : undefined;
  return item && !Object.hasOwn(item, bound.$item) ? (schema.fields[bound.$item] as { default?: unknown } | undefined)?.default : undefined;
}

/**
 * The picture an image shows, for choosing its focal point, with the style rules under its own. `value` is the
 * image as the page shows it (`shownValue`), undefined when that can't be told; `unknown` then says why.
 */
function focusImage(state: ProjectState, devUrl: string | null, value: unknown, below: FocusImage['below'], unknown: string, own?: ResponsiveStyles): FocusImage {
  if (value === undefined || isBinding(value)) return { src: null, below, own, missing: unknown };
  const assetId = (value as ImageValue | null)?.assetId;
  const asset = assetId && Object.hasOwn(state.assets.assets, assetId) ? state.assets.assets[assetId] : undefined;
  if (!asset) return { src: null, below, own, missing: 'No picture is chosen yet.' };
  return { src: assetUrl(devUrl, asset.file), width: asset.width, height: asset.height, below, own };
}

/**
 * What a single item shows under its own styles: the part's design, then the placement's shared changes, which win
 * over the design at every size (a shared all-sizes value beats the design's phone value). Cascaded the way the
 * stylesheet writes them, so each size carries the whole cascade.
 */
function sharedPartStyles(def: ComponentDefinition, nodeId: string, inst: InstanceNode, partId: string): ResponsiveStyles {
  const design = designStyles(def, nodeId, inst.variants);
  return cascadeStyles([
    { styles: design, strength: 1 },
    { styles: inst.overrides?.[partId], strength: 2, wideColumns: true, unhides: [design] }
  ]);
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

/** How long an "Open in inspector" request waits for its component's Inspector, and then for the field to show. */
const REVEAL_MS = 5000;
const REVEAL_FIELD_MS = 1000;

/** Bring a content field into view, put focus on its control and ring it briefly. Nothing is clicked or changed. */
function revealField(slot: HTMLElement) {
  const box = (slot.firstElementChild as HTMLElement | null) ?? slot;
  const control = slot.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, [contenteditable="true"], button');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  box.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  control?.focus({ preventScroll: true });
  box.classList.remove('field-located');
  // Restarts the ring when the same field is opened again.
  void box.offsetWidth;
  box.classList.add('field-located');
  setTimeout(() => box.classList.remove('field-located'), 2600);
}

/** The field a request names in the Inspector: one of the component's own, or one of a list item's (once open). */
function findField(req: InspectorFocus): HTMLElement | null {
  const panel = document.getElementById('dock-panel-inspect');
  const own = [...(panel?.querySelectorAll<HTMLElement>(`[data-field="${CSS.escape(req.prop)}"]`) ?? [])].find((el) => !el.parentElement?.closest('.list-editor-body'));
  if (!own || !req.itemId) return own ?? null;
  const body = own.querySelector<HTMLElement>(`#list-item-${CSS.escape(req.itemId)}`);
  if (!body || body.hidden) return null;
  return body.querySelector<HTMLElement>(`[data-field="${CSS.escape(req.field ?? '')}"]`);
}

/**
 * Take an "Open in inspector" request meant for this component: open Content (the list item opens through
 * `reveal`), then reveal the field once it shows. The request is used once, found or not.
 */
function useFieldReveal(selection: ElementRef): InspectorFocus | null {
  const req = useStore((s) => {
    const f = s.inspectorFocus;
    const here = f && f.owner.kind === selection.owner.kind && f.owner.id === selection.owner.id && f.nodeId === selection.nodeId;
    return here && !selection.instancePath.length && !selection.partId && f.opening === s.snapshot?.workspaceKey ? f : null;
  });
  useEffect(() => {
    if (!req) return;
    const done = () => {
      if (getState().inspectorFocus?.seq === req.seq) setState({ inspectorFocus: null });
    };
    // Too late: the author has moved on since asking for it.
    if (Date.now() - req.at > REVEAL_MS) return done();
    openSection('content', { scroll: false });
    const until = Date.now() + REVEAL_FIELD_MS;
    let frame = 0;
    const step = () => {
      const el = findField(req);
      if (el) {
        revealField(el);
        done();
      } else if (Date.now() < until) frame = requestAnimationFrame(step);
      else {
        // It was there when the button was pressed, and has gone since (or is not shown here): say so.
        done();
        toast(`${req.label} is no longer in the Inspector.`, 'info');
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [req?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  return req;
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
    // Outside picks (another section) show the overview: the mode edits this component only. A part of a component
    // placed in the design (its row in Layers) shows that part, as this design sets it.
    const view = definitionView(st, editingDef.id, selection);
    return (
      <div className="panel-body insp" key={selection ? JSON.stringify(selection) : 'def-overview'}>
        {view.kind === 'node' ? (
          <DefinitionNodeInspector state={st} def={editingDef} node={view.node} tokens={tokens} />
        ) : view.kind === 'nested-part' ? (
          <PartInspector state={st} selection={selection!} tokens={tokens} everywhere={editingDef} />
        ) : (
          <DefinitionOverview state={st} def={editingDef} />
        )}
      </div>
    );
  }
  // Keyed by page: fields being typed in belong to their page, never to the one shown after it.
  if (!selection) return pageId ? <PageSettings key={pageId} page={st.pages[pageId]} state={st} /> : null;
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
  const pageId = useStore((s) => s.pageId);
  if (owner.kind === 'shell') {
    const { pages: n, here } = shellReach(state, owner.id, pageId);
    // Which pages inherit it, by name: one edit here (a notice, a menu link) reaches every one of them.
    const names = shellPageNames(state, owner.id);
    return (
      <Scope tone="shared" icon={<Users />} aside={aside}>
        <strong>Shared {owner.id}.</strong> {here ? '' : 'Not shown on this page. '}
        {n === 0 ? (
          'No page shows it.'
        ) : (
          <>
            Changes show on {n === 1 ? 'the 1 page' : `all ${n} pages`} that use it:{' '}
            <span className="insp-scope-pages" title={names.all}>
              {names.text}
            </span>
            .
          </>
        )}
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
  const devUrl = useDevUrl();
  // Which declared part of a code component the Style section edits.
  const [codePart, setCodePart] = useState('root');
  const reveal = useFieldReveal(selection);
  const styleItems = useStyleCopyItems(selection);
  const def = state.components[node.definitionId];
  if (!def) return null;
  const title = node.name ?? def.name;
  const shell = owner.kind === 'shell';
  // An axis with one option is not a choice. Every kind of component offers its axes, code components included.
  const axes = axesOf(def).filter(([, a]) => Object.keys(a.options).length > 1);
  const selectedAxes = selectedVariants(def, node.variants);
  const uses = instancesOf(state, def.id).length;
  const partIds = def.kind === 'managed' ? Object.keys(def.parts).filter((p) => p !== 'root') : [];
  const rootPart = def.parts.root;
  // A code component takes style changes only when it places the classes it is given.
  const codeStyled = def.kind === 'code' && codeTakesOverrides(def);
  const styledPart = def.kind === 'code' && def.parts[codePart] ? codePart : 'root';
  // Making a code component unique copies its source into the project, which is only editable in developer mode.
  const canMakeUnique = def.kind === 'managed' || dev;
  const origin = def.owner === 'project' ? (def.kind === 'code' ? 'Code component' : 'Your component') : 'From the theme';
  const set = (prop: string, value: unknown, edit?: PendingEdit) => applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }], `Edit ${def.properties[prop]?.label ?? prop}`, `${node.id}:${prop}`);
  const onStyle = (partId: string) => (property: string, value: StyleValue | null, expectedRevision?: number) =>
    commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId, scope, property, value }], `Style ${def.parts[partId]?.label ?? partId}`, styleKey(property, `${node.id}:${partId}:${scope}:${property}`), expectedRevision);
  // A component whose whole design is one image (made from a cropped page image) chooses its focus here.
  const rootNodeId = rootPart?.nodeId ?? def.tree?.rootIds[0];
  const rootNode = rootNodeId ? def.tree?.nodes[rootNodeId] : undefined;
  const rootImage =
    rootNode?.kind === 'image' && rootNodeId
      ? focusImage(state, devUrl, shownImage(state, { owner, instancePath: [node.id], nodeId: rootNodeId }, rootNode.image), [selectedVariantStyles(def, node.variants, rootNodeId), [rootNode.styles]], 'This picture can’t be shown here.')
      : undefined;
  const overrides = countStyles(node.overrides?.[styledPart]);
  const selectPart = (p: string) => selectAndFocus({ owner, instancePath: [node.id], nodeId: def.parts[p].nodeId, partId: p });
  const editEverywhere = () => setState({ modal: { kind: 'edit-definition', ref: selection } });
  const makeUnique = () => setState({ modal: { kind: 'make-unique', owner, nodeId: node.id, definitionId: def.id } });
  const viewSource = () => setState({ modal: { kind: 'source', definitionId: def.id } });
  // The copy's structure is now edited in source, so offer to open it straight away.
  const convertToCode = async () => {
    const r = await applyOps([{ type: 'component.convertToCode', owner, nodeId: node.id }], 'Convert to code');
    const id = r?.[0]?.definitionId as string | undefined;
    if (id) toast('Converted to a code component. Its properties stay editable here.', 'info', { label: 'Open code', run: () => setState({ modal: { kind: 'source', definitionId: id } }) });
  };
  const items: MenuItem[] = [
    ...(def.kind === 'managed' ? [{ label: 'Edit everywhere…', icon: <Pencil />, onSelect: editEverywhere }] : []),
    ...(canMakeUnique ? [{ label: 'Make unique…', icon: <Split />, hint: 'Separate copy', onSelect: makeUnique }] : []),
    ...(dev && def.kind === 'managed' ? [{ label: 'Convert to code', icon: <Code />, onSelect: () => void convertToCode() }] : []),
    ...(dev ? [{ label: def.kind === 'code' && def.owner === 'project' ? 'Edit code' : 'View source', icon: <FileCode2 />, onSelect: viewSource }] : []),
    ...(styleItems.length ? [...(def.kind === 'managed' || canMakeUnique ? [{ separator: true }] : []), ...styleItems] : []),
    ...(partIds.length ? [{ separator: true }, { heading: 'Select a part' }, ...partIds.map((p) => ({ label: def.parts[p].label, onSelect: () => selectPart(p) }))] : []),
    ...(!shell
      ? [
          { separator: true },
          { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
          { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
        ]
      : [])
  ];
  // A contact form shows only the setting its service needs. The others keep their values for a switch back.
  const service = formServiceSetup(def, node.props);
  const fields = groupFields(
    Object.entries(def.properties)
      .filter(([key]) => !service?.hidden.includes(key))
      .map(([key, schema]) => ({ key, schema, data: null }))
  );
  // Buttons with no link are left out of the site: flag each at the field that sets its link. Hide is offered there
  // only when that field and the label belong to the same one button (not a link or label every item shares).
  const unlinked = unlinkedAt(state, owner, node.id);
  const hideAction = (b: UnlinkedButton | undefined) => (b?.hide ? { label: 'Hide button', run: () => void applyOps([hideButtonOp(owner, node.id, b.hide!)], 'Hide button') } : undefined);
  const formNotes = (key: string) => (key === 'fields' && namesFormFields(def) ? formKeyNotes(def, node.props.fields) : undefined);
  const notes = (key: string) => {
    const form = formNotes(key);
    if (!unlinked.some((b) => b.link?.prop === key && b.link.itemId)) return form;
    return (item: ListItem, i: number): ListItemNote | undefined => {
      const b = unlinked.find((x) => x.link?.prop === key && x.link.itemId === item.id);
      const own = hideAt(b, item.id);
      return form?.(item, i) ?? (b?.link?.field ? { field: b.link.field, error: unlinkedNote({ hide: own?.hide }), action: hideAction(own) } : undefined);
    };
  };
  // Buttons whose link this placement cannot set (it comes from the design or a component inside it).
  const fixedUnlinked = unlinked.filter((b) => !b.link);
  // A video section says whether its address is a video visitors can play, where it loads from, and when it needs a title.
  const video = def.componentId === 'media.video' ? videoFieldNotes(node.props) : undefined;
  const videoNote = (key: string) => (key === 'url' || key === 'title' ? video?.[key as keyof VideoFieldNotes] : undefined);
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
        {fixedUnlinked.map((b, i) => (
          <p key={i} className="field-error insp-note">
            “{b.label}” has no link, so visitors won’t see it. Its link is set in the section’s design: choose Edit everywhere and select the button, or the component it belongs to, to give it one.
          </p>
        ))}
        <FieldGroups
          groups={fields}
          render={({ key, schema, label }) => {
            const found = unlinkedField(unlinked, key);
            const own = hideAt(found);
            return (
              <PropField
                key={key}
                name={key}
                schema={schema}
                label={label}
                hint={service && key === service.prop ? formServiceHint(service) : videoHint(videoNote(key))}
                value={node.props[key] ?? schema.default}
                onChange={(v, edit) => set(key, v, edit)}
                onList={(op) => applyListOp(owner, node.id, key, op, `Edit ${schema.label}`, op.kind === 'field' ? `${node.id}:${key}:${op.itemId}:${op.field}` : undefined)}
                read={() => readProp(owner, node.id, key)}
                onTable={(edit) => applyTableEdit(owner, node.id, key, edit, `Edit ${schema.label}`)}
                state={state}
                openItem={reveal?.prop === key && reveal.itemId ? { seq: reveal.seq, itemId: reveal.itemId } : undefined}
                annotate={notes(key)}
                hiddenFields={key === 'fields' && offersFormChoices(def) ? formFieldSettingsHidden : undefined}
                linkPairs={schema.type === 'list' ? itemLinkPairs(def, key) : undefined}
                error={found ? unlinkedNote({ hide: own?.hide }) : videoNote(key)?.error}
                action={hideAction(own)}
                place={schema.type === 'list' ? { ref: selection, list: key } : undefined}
              />
            );
          }}
        />
      </Section>
      {axes.length > 0 && (
        <Section title="Design" id="design" level={LEVEL}>
          {axes.map(([axisId, axis]) => (
            <Field key={axisId} label={axis.label}>
              {isBinding(selectedAxes[axisId]) ? (
                // Chosen by a property of the component this one sits in.
                <select className="select" value="" disabled>
                  <option value="">Set by a property</option>
                </select>
              ) : (
                <select className="select" value={String(selectedAxes[axisId])} onChange={(e) => void applyOps([{ type: 'instance.setVariant', owner, nodeId: node.id, axis: axisId, variant: e.target.value }], `Change ${axis.label.toLowerCase()}`)}>
                  {Object.entries(axis.options).map(([id, v]) => (
                    <option key={id} value={id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          ))}
        </Section>
      )}
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
          <StyleControls
            styles={node.overrides?.root}
            inherited={designStyles(def, rootPart?.nodeId ?? def.tree!.rootIds[0], node.variants)}
            wideColumns
            allowed={placementStyleControls(def, 'root', codeStyled) ?? undefined}
            tokens={tokens}
            image={rootImage}
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
            wideColumns
            allowed={placementStyleControls(def, styledPart, codeStyled) ?? undefined}
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
              <Split /> Make unique…
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
          <Field label="Anchor ID" hint={`Lets links jump straight to this ${shell ? 'part of every page that shows it' : 'section'}, as #${node.anchor || 'pricing'}. Choose it in a link’s Section.`}>
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

/**
 * A part of a placed component. `everywhere` is the component being edited everywhere when the part belongs to a
 * component placed in its design: changes then go to that design, for every placement of it.
 */
function PartInspector({ state, selection, tokens, everywhere }: { state: ProjectState; selection: ElementRef; tokens: Tokens; everywhere?: ComponentDefinition }) {
  const scope = useStore((s) => s.styleScope);
  const styleItems = useStyleCopyItems(selection);
  const devUrl = useDevUrl();
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
    if (!isBinding(v)) return;
    const b = '$prop' in v ? { prop: v.$prop, kind } : { item: v.$item, kind };
    if (!bindings.some((x) => x.prop === b.prop && x.item === b.item)) bindings.push(b);
  };
  if (node.kind === 'text') pushB(node.text, 'text');
  // A heading's level, when its placement chooses it, sits beside its words: it changes the outline, never the look.
  // A level shared by every item is left to the section when the words are each item's own, so neither says "this one only" wrongly.
  if (node.kind === 'text' && !(isBinding(node.text) && '$item' in node.text && isBinding(node.tag) && '$prop' in node.tag)) pushB(node.tag, 'tag');
  if (node.kind === 'image') pushB(node.image, 'image');
  if (node.kind === 'link') (pushB(node.label, 'label'), pushB(node.link, 'link'), pushB(node.icon, 'icon'));
  if (node.kind === 'element') pushB(node.link, 'link');
  if (node.kind === 'icon') pushB(node.icon, 'icon');
  const contentList = Object.entries(def.properties).find(([, p]) => p.type === 'list' && bindings.some((b) => b.item && b.item in (p as { fields: object }).fields))?.[0];
  // A structural part (a card itself) has no content binding, but it still repeats once per list item:
  // find the list from the repeat that encloses it, so its Style scope says "All 3 cards" too.
  const repeatList = enclosingRepeatProp(def, node.id);
  // The repeat that encloses the part names its list exactly; a field-name match is only a fallback.
  const listProp = (repeatList && def.properties[repeatList]?.type === 'list' ? repeatList : undefined) ?? contentList;
  const listSchema = listProp ? (def.properties[listProp] as Extract<ComponentDefinition['properties'][string], { type: 'list' }>) : undefined;
  // A list the outer design fills in from one of its own properties is not this placement's to list here.
  const ownList = listProp ? (inst.props[listProp] ?? listSchema?.default) : undefined;
  const listItems = Array.isArray(ownList) ? (ownList as Array<Record<string, unknown>>) : [];
  const itemLabel = listSchema?.itemLabel.toLowerCase() ?? 'item';
  const listLabel = listSchema?.label.toLowerCase() ?? 'items';
  const itemIndex = itemId ? listItems.findIndex((x) => x.id === itemId) : -1;
  const partName = (part?.label ?? 'part').toLowerCase();
  const n = listItems.length;
  const instOwner = owner;
  const instNodeId = selection.instancePath[0];
  // Edits join the same field's last edit. In a component's design the same node IDs can recur in another design
  // copied from it, so the key names the design too, as its row in Layers does.
  const keyAt = everywhere ? `${everywhere.id}:${instNodeId}` : instNodeId;
  // A part shown once per item of the list (a card) can also be styled for the selected item alone.
  const itemList = !nested && partId && owner.kind !== 'component' ? repeatedPartList(def, partId) : undefined;
  const canStyleItem = !!itemList && itemList === listProp && !!itemId && itemIndex >= 0;
  // The selected item has left the list (removed, or an undo took it back): neither its own style nor the shared
  // one is what the author picked, so nothing is offered until they select again.
  const itemGone = !!itemList && itemList === listProp && !!itemId && itemIndex < 0;
  const ownItemStyles = canStyleItem ? itemStylesOf(def, inst, partId!, itemId!) : undefined;
  const [reach, setReach] = useState<'all' | 'item'>(ownItemStyles ? 'item' : 'all');
  const oneItem = canStyleItem && reach === 'item';
  const itemName = (it: Record<string, unknown> | undefined, i: number) => {
    const t = listSchema?.titleField ? it?.[listSchema.titleField] : undefined;
    return typeof t === 'string' && t.trim() ? `“${t.trim()}”` : `${listSchema?.itemLabel ?? 'Item'} ${i + 1}`;
  };
  const thisItem = itemIndex >= 0 ? itemName(listItems[itemIndex], itemIndex) : '';
  // Items of this placement that keep styles of their own, listed under the shared style so they can be found again.
  const styledItems = itemList && itemList === listProp && partId ? Object.keys(liveItemStyles(def, inst, partId)?.items ?? {}).map((id) => ({ id, index: listItems.findIndex((x) => x.id === id) })).filter((x) => x.index >= 0) : [];
  // Style reach, worded the same in the header and on the Style heading.
  const styleReach = oneItem ? `this ${partName} only` : n === 1 ? `the 1 ${partName}` : `all ${n} ${partName}s`;
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
  // A repeated link whose visible text and destination are two fields of the selected item (a contact method).
  const textField = node.kind === 'link' && isBinding(node.label) && '$item' in node.label ? node.label.$item : undefined;
  const linkField = node.kind === 'link' && isBinding(node.link) && '$item' in node.link ? node.link.$item : undefined;
  const linkPair = !nested && listProp && textField && linkField ? itemLinkPairs(def, listProp).find((p) => p.text === textField && p.link === linkField) : undefined;
  const pairedItem = linkPair && itemId ? listItems.find((x) => x.id === itemId) : undefined;
  // A clicked button with no link (the one rendered for this item): flag its link field and offer to hide it, then
  // select the section, since the button is gone.
  const at = (selection.itemPath ?? []).join(',');
  const unlinked = node.kind === 'link' && !nested ? unlinkedAt(state, instOwner, instNodeId).find((b) => b.defNodeId === node.id && (b.itemPath ?? []).join(',') === at) : undefined;
  const hideAction = unlinked?.hide
    ? {
        label: 'Hide button',
        run: async () => {
          if (await applyOps([hideButtonOp(instOwner, instNodeId, unlinked.hide!)], 'Hide button')) selectAndFocus(parent);
        }
      }
    : undefined;
  const flagged = (kind: string) => (kind === 'link' && unlinked?.link ? { error: unlinkedNote(unlinked), action: hideAction } : {});
  // Content reach comes from the binding: an item field is per item, a section property is shared by every item.
  const perItem = bindings.some((b) => b.item);
  const contentReach = !hasContent || !listSchema ? '' : perItem ? (itemId ? `This ${itemLabel} only${itemIndex >= 0 ? ` (${itemIndex + 1} of ${n})` : ''}` : `Each ${itemLabel} has its own`) : `Same in every ${itemLabel}`;
  // The item this part belongs to stays revealed on the page while it is selected: picking an answer inside a question
  // the inspector opened must not close that question under the pointer.
  const reveal = useRevealedItem(!nested && listProp && itemIndex >= 0 ? { ref: parent, list: listProp } : undefined, itemIndex >= 0 ? (listItems[itemIndex] as ListItem) : undefined, true);
  // A cropped image part chooses its focal point on its own picture (the selected item's, for a repeated one),
  // over the rules the exported site puts under this placement's: the selected variants, then the design.
  const partImage =
    part && node.kind === 'image'
      ? focusImage(state, devUrl, shownImage(state, selection, node.image), [selectedVariantStyles(def, inst.variants, part.nodeId), [def.tree?.nodes[part.nodeId]?.styles]], listSchema && !itemId ? `Select one ${itemLabel} on the page to see its picture here.` : 'This picture can’t be shown here.')
      : undefined;
  // One item's picture: the style every item shares is the strongest rule under the item's own.
  const itemImage =
    part && node.kind === 'image' && oneItem
      ? focusImage(state, devUrl, shownImage(state, selection, node.image), [[inst.overrides?.[partId!]], selectedVariantStyles(def, inst.variants, part.nodeId), [def.tree?.nodes[part.nodeId]?.styles]], 'This picture can’t be shown here.')
      : undefined;
  // Rows the shared style uses show for one item too, so the item can change what every item was given.
  const sharedRows = (controls: string[] | undefined) => controls && [...new Set([...controls, ...Object.values(inst.overrides?.[partId!] ?? {}).flatMap((sc) => Object.keys(sc ?? {}))])];

  return (
    <>
      <Header
        title={title}
        kind={parentLink}
        tone={everywhere ? 'definition' : owner.kind === 'shell' ? 'shared' : 'local'}
        icon={kind.icon}
        actions={everywhere ? <DoneButton /> : <SelectionActions title={title} selection={selection} items={[{ label: `Select ${parentName}`, icon: <Component />, shortcut: 'Esc', onSelect: () => selectAndFocus(parent) }, ...(styleItems.length ? [{ separator: true }, ...styleItems] : [])]} />}
      >
        {everywhere ? <EverywhereScope state={state} def={everywhere} /> : <OwnerScope owner={owner} state={state} />}
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
        <Section title="Content" id="part-content" level={LEVEL} scope={listSchema ? (perItem ? (itemId ? `This ${itemLabel} only` : `Each ${itemLabel}`) : `Every ${itemLabel}`) : everywhere ? 'Same in every placement' : undefined}>
          {bindings.map((b, i) => {
            if (b.prop) {
              const schema = def.properties[b.prop];
              if (!schema) return null;
              // Filled in from a property of the design this component sits in: that property's default.
              const forwarded = everywhere ? forwardedProp(inst.props[b.prop]) : null;
              if (forwarded) return <ForwardedDefault key={i} state={state} def={everywhere!} prop={forwarded} />;
              // Filled in from each item of a list the design repeats it over.
              if (isBinding(inst.props[b.prop]))
                return (
                  <p key={i} className="muted insp-note">
                    {schema.label}: each item of the list it repeats over has its own.
                  </p>
                );
              return (
                <div key={i} data-field={b.prop} style={{ display: 'contents' }}>
                <PropField
                  name={b.prop}
                  schema={schema}
                  value={inst.props[b.prop] ?? schema.default}
                  state={state}
                  everywhere={!!everywhere}
                  onChange={(v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: b.prop!, value: v }], `Edit ${schema.label}`, `${keyAt}:${b.prop}`)}
                  onList={(op) => applyListOp(instOwner, instNodeId, b.prop!, op, `Edit ${schema.label}`)}
                  read={() => readProp(instOwner, instNodeId, b.prop!)}
                  onTable={(edit) => applyTableEdit(instOwner, instNodeId, b.prop!, edit, `Edit ${schema.label}`)}
                  linkPairs={schema.type === 'list' ? itemLinkPairs(def, b.prop!) : undefined}
                  {...flagged(b.kind)}
                  place={schema.type === 'list' ? { ref: parent, list: b.prop! } : undefined}
                />
                </div>
              );
            }
            if (listProp && listSchema && itemId) {
              const field = listSchema.fields[b.item!];
              const item = listItems.find((x) => x.id === itemId);
              if (!field || !item) return null;
              const edit = (v: unknown, pending?: PendingEdit) => void applyWith(pending, [{ type: 'instance.setProp', owner: instOwner, nodeId: instNodeId, prop: listProp, itemId, field: b.item!, value: v }], `Edit ${field.label}`, `${keyAt}:${listProp}:${itemId}:${b.item}`);
              // A page list's card says where an empty field's text comes from.
              const teaser = teaserFieldNote(state, listSchema, item, b.item!);
              // An item without its own value for the field shows the field's default, on the site and here.
              const value = Object.hasOwn(item, b.item!) ? item[b.item!] : field.default;
              return (
                <div key={`${itemId}:${b.item}`} data-field={b.item} style={{ display: 'contents' }} {...reveal.handlers}>
                  <ScalarField schema={field} value={value} state={state} onChange={edit} hint={teaser?.hint} placeholder={teaser?.placeholder} onLive={field.type === 'string' ? reveal.typed(b.item!) : undefined} {...flagged(b.kind)} />
                </div>
              );
            }
            return null;
          })}
          {linkPair && pairedItem && itemId && (
            <ContactMismatch text={pairedItem[linkPair.text]} link={pairedItem[linkPair.link]} onRepair={(link, label, revision) => applyListOp(instOwner, instNodeId, listProp!, { kind: 'repair', itemId, field: linkPair.link, value: link, label, revision }, label)} />
          )}
          {listSchema && perItem && !itemId && <p className="muted insp-note">Each {itemLabel} has its own text. {everywhere ? (Array.isArray(ownList) ? 'Open the list to edit them.' : `Each placement of ${everywhere.name} fills them in.`) : 'Click one on the page to change it, or open the list to edit them all.'}</p>}
          {listSchema && Array.isArray(ownList) && (
            <button className="btn btn-sm insp-inline-btn" onClick={() => openList(parent, listProp!, itemId ?? (listItems[0]?.id as string | undefined), !!itemId)}>
              <List /> {itemId ? `Show in ${listLabel} list` : `Open ${listLabel} list`}
            </button>
          )}
        </Section>
      ) : (
        <Section title="Content" id="part-content" level={LEVEL}>
          <p className="muted insp-note">
            {everywhere
              ? `This is fixed in the ${def.name} design. To change it, click Done editing, then edit ${def.name} everywhere.`
              : `This is fixed in the section’s design. To change it, select ${def.name} and choose Edit everywhere, or Make unique for just this placement.`}
          </p>
        </Section>
      )}
      {part && !nested && def.kind === 'managed' && (
        <Section
          title="Style"
          id="part-style"
          level={LEVEL}
          scope={[listSchema ? styleReach.charAt(0).toUpperCase() + styleReach.slice(1) : '', countStyles(oneItem ? ownItemStyles : inst.overrides?.[partId!]) ? changes(countStyles(oneItem ? ownItemStyles : inst.overrides?.[partId!])) : ''].filter(Boolean).join(' · ') || undefined}
        >
          {canStyleItem && (
            <Segmented
              full
              label={`Style which ${partName}s`}
              value={reach}
              onChange={setReach}
              options={[
                // Named by their visible text: a title would replace it as the accessible name.
                { value: 'all', label: n === 1 ? `The ${partName}` : `All ${n} ${partName}s` },
                { value: 'item', label: `This ${partName}` }
              ]}
            />
          )}
          {itemGone ? (
            <p className="muted insp-note">
              This {itemLabel} is no longer in the list. Select another {itemLabel}, or{' '}
              <button className="link-btn" onClick={() => selectAndFocus(parent)}>
                select {parentName}
              </button>
              .
            </p>
          ) : oneItem ? (
            <>
              <p className="muted insp-note">
                Changes here apply to {thisItem} only. Anything it does not change follows the style all {listLabel} share.
              </p>
              <StyleControls
                key={`item:${itemId}`}
                styles={ownItemStyles}
                inherited={sharedPartStyles(def, part.nodeId, inst, partId!)}
                wideColumns
                // Rows the shared style uses show here too, so the item can change what every item was given.
                allowed={sharedRows(partStyleControls(def, partId!))}
                tokens={tokens}
                image={itemImage}
                resetLabel="Reset to shared style"
                target={thisItem}
                onSet={(property, value, expectedRevision) =>
                  commitOps(
                    [{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, itemId, scope, property, value }],
                    `Style ${thisItem}`,
                    styleKey(property, JSON.stringify([keyAt, partId, itemId, scope, property])),
                    expectedRevision
                  )
                }
                onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId, itemId, scope: sc }], `Reset ${thisItem} to shared style`)}
              />
            </>
          ) : (
            <>
              {styledItems.length > 0 && (
                <p className="muted insp-note">
                  {styledItems.length === 1 ? 'Styled on its own: ' : 'Styled on their own: '}
                  {styledItems.map((x, i) => (
                    <span key={x.id}>
                      {i > 0 ? ', ' : ''}
                      <button
                        className="link-btn"
                        // The selected card's own style is one choice away; any other card is selected.
                        onClick={() => (x.id === itemId && canStyleItem ? setReach('item') : selectAndFocus({ ...selection, itemPath: [x.id] }))}
                        title={`Show ${itemName(listItems[x.index], x.index)}’s own style, to change or reset it`}
                      >
                        {itemName(listItems[x.index], x.index)}
                      </button>
                    </span>
                  ))}
                  . Their own changes win over the shared style.
                </p>
              )}
              <StyleControls
                key="all"
                styles={inst.overrides?.[partId!]}
                inherited={designStyles(def, part.nodeId, inst.variants)}
                wideColumns
                allowed={partStyleControls(def, partId!)}
                tokens={tokens}
                image={partImage}
                onSet={(property, value, expectedRevision) =>
                  commitOps([{ type: 'node.setStyle', owner: instOwner, nodeId: instNodeId, partId, scope, property, value }], `Style ${part.label}`, styleKey(property, `${keyAt}:${partId}:${scope}:${property}`), expectedRevision)
                }
                onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner: instOwner, nodeId: instNodeId, partId, scope: sc }], 'Reset part overrides')}
              />
            </>
          )}
        </Section>
      )}
    </>
  );
}

function PrimitiveInspector({ state, owner, node, tokens, selection }: { state: ProjectState; owner: OwnerRef; node: GraphNode; tokens: Tokens; selection: ElementRef }) {
  const scope = useStore((s) => s.styleScope);
  const devUrl = useDevUrl();
  const content = (field: Extract<EditOperation, { type: 'node.setContent' }>['field'], value: unknown, edit?: PendingEdit) => void applyWith(edit, [{ type: 'node.setContent', owner, nodeId: node.id, field, value }], `Edit ${field}`, `${node.id}:${field}`);
  const t = structuralTarget(selection);
  const title = refLabel(state, selection);
  const kind = elementKind(node);
  const iconId = useId();
  // A button with no link is left out of the site: say so under its link, and offer to remove it.
  const unlinked = node.kind === 'link' && unlinkedAt(state, owner, node.id).some((b) => !b.defNodeId);
  // A button with an anchor may be where another link goes: removing it would take that target away.
  const removable = !!t && owner.kind !== 'shell' && !node.anchor;
  const styleItems = useStyleCopyItems(selection);
  const structural = !!t && owner.kind !== 'shell';
  const items: MenuItem[] = [
    ...(t && structural && node.kind === 'element' ? [{ label: 'Create component…', icon: <Component />, onSelect: () => setState({ modal: { kind: 'create-component', ref: t } }) }, { separator: true }] : []),
    ...styleItems,
    ...(structural
      ? [
          ...(styleItems.length ? [{ separator: true }] : []),
          { label: 'Duplicate', icon: <Copy />, shortcut: '⌘D', onSelect: () => void duplicateSelection() },
          { label: 'Delete', icon: <Trash2 />, shortcut: '⌫', danger: true, onSelect: () => void deleteSelection() }
        ]
      : [])
  ];
  return (
    <>
      <Header title={title} kind={title.toLowerCase().startsWith(kind.name.toLowerCase()) ? 'Basic element' : `${kind.name} · basic element`} tone={owner.kind === 'shell' ? 'shared' : owner.kind === 'component' ? 'definition' : 'local'} icon={kind.icon} actions={<SelectionActions title={title} selection={selection} items={items} />}>
        <OwnerScope owner={owner} state={state} />
      </Header>
      <Section title="Content" id="prim-content" level={LEVEL}>
        {node.kind === 'text' && (
          <>
            {!node.rich && !isBinding(node.tag) && (
              <Field label="Type">
                <select className="select" value={node.tag} onChange={(e) => content('tag', e.target.value)}>
                  {['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].map((tg) => (
                    <option key={tg} value={tg}>
                      {tg === 'p' ? 'Paragraph' : `Heading ${tg.slice(1)}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div data-field="text" style={{ display: 'contents' }}>
              <Field label="Text" hint="Or double-click the text on the page to edit it there.">
                <DraftInput multiline rows={2} value={Array.isArray(node.text) ? richTextToMarkdown(toRichText(node.text), state.pages) : isBinding(node.text) ? '' : String(node.text)} onCommit={(v) => content('text', v)} />
              </Field>
            </div>
          </>
        )}
        {node.kind === 'image' && !isBinding(node.image) && (
          <div className="field" role="group" aria-label="Image">
            <ImageEditor value={node.image} onChange={(v) => content('image', v)} state={state} />
          </div>
        )}
        {node.kind === 'link' && (
          <>
            <div data-field="label" style={{ display: 'contents' }}>
              <Field label="Label">
                <DraftInput value={isBinding(node.label) ? '' : String(node.label)} onCommit={(v) => content('label', v)} />
              </Field>
            </div>
            {!isBinding(node.link) && (
              <div className="field" data-field="link" role="group" aria-labelledby={`${node.id}-dest`} aria-describedby={unlinked ? `${node.id}-dest-note` : undefined}>
                <div className="field-label" id={`${node.id}-dest`}>
                  Link
                </div>
                <LinkEditor value={node.link} onChange={(v, edit) => content('link', v, edit)} state={state} label={kind.name} />
                {unlinked && (
                  <>
                    <div className="field-error" id={`${node.id}-dest-note`}>
                      {removable ? 'No link yet, so visitors won’t see this button. Choose where it goes, or remove it.' : 'No link yet, so visitors won’t see this button. Choose where it goes.'}
                    </div>
                    {removable && (
                      <button className="btn btn-sm insp-inline-btn" onClick={() => void deleteSelection()}>
                        <Trash2 /> Remove button
                      </button>
                    )}
                  </>
                )}
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
          image={node.kind === 'image' ? focusImage(state, devUrl, shownImage(state, selection, node.image), [], 'This picture can’t be shown here.') : undefined}
          onSet={(property, value, expectedRevision) => commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value }], `Style ${property}`, styleKey(property, `${node.id}:${scope}:${property}`), expectedRevision)}
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

/** Who a change made while editing a component everywhere reaches. */
function EverywhereScope({ state, def }: { state: ProjectState; def: ComponentDefinition }) {
  const uses = instancesOf(state, def.id).length;
  return (
    <Scope tone="definition" icon={<Pencil />}>
      <strong>Editing everywhere.</strong>{' '}
      {uses === 1 ? `Used once, on ${placesText(state, def)}, and wherever you add it later. A placement’s own changes still win.` : `Changes apply to all ${uses} placements, except where one has its own changes.`}
    </Scope>
  );
}

const FIELD_NAME: Record<ContentField, string> = { text: 'text', label: 'button text', link: 'link', image: 'image', icon: 'icon' };

/** A property default's field: its editor, then which placements show it. */
function DefaultField({ state, def, prop, schema, onChange, label }: { state: ProjectState; def: ComponentDefinition; prop: string; schema: ScalarPropSchema; onChange: (v: unknown, edit?: PendingEdit) => void; label?: string }) {
  return (
    <div data-field={prop} style={{ display: 'contents' }}>
      <ScalarField schema={schema} value={schema.default} state={state} label={label ?? schema.label} hint={`Each placement fills this in. ${reachText(defaultReach(state, def.id, prop))}`} onChange={onChange} everywhere />
    </div>
  );
}

/**
 * A nested component's input that the design fills in from one of its own properties: that property's default,
 * which every placement without its own value shows.
 */
function ForwardedDefault({ state, def, prop }: { state: ProjectState; def: ComponentDefinition; prop: string }) {
  const schema = Object.hasOwn(def.properties, prop) ? def.properties[prop] : undefined;
  if (!schema) return null;
  if (schema.type === 'list' || schema.type === 'table') return <p className="muted insp-note">Each placement of {def.name} fills this in, as its {schema.label.toLowerCase()}.</p>;
  const change = (v: unknown, edit?: PendingEdit) => void applyWith(edit, [propDefaultOp(def.id, prop, v)], `Edit ${schema.label} default`, `${def.id}:default:${prop}`);
  return <DefaultField state={state} def={def} prop={prop} schema={schema} onChange={change} />;
}

/** The content a node of the design holds: defaults each placement fills in, values fixed in the design, per-item notes. */
function DesignContentSection({ state, def, node }: { state: ProjectState; def: ComponentDefinition; node: GraphNode }) {
  const iconId = useId();
  const fields = designContent(def, node);
  if (!fields.length) return null;
  const kind = elementKind(node).name;
  const set = (f: DesignContent, label: string) => (v: unknown, edit?: PendingEdit) => void applyWith(edit, [designContentOp(def, node.id, f.field, v)], label, `${def.id}:${node.id}:${f.field}`);
  const items = fields.filter((f): f is Extract<DesignContent, { source: 'item' }> => f.source === 'item');
  const list = items[0]?.list ? (def.properties[items[0].list] as ListProp | undefined) : undefined;
  const sources = new Set(fields.map((f) => f.source));
  const scope = sources.size > 1 ? undefined : sources.has('design') ? 'Same in every placement' : sources.has('default') ? 'Filled in on each placement' : `Each ${list?.itemLabel.toLowerCase() ?? 'item'}`;
  return (
    <Section title="Content" id="def-content" level={LEVEL} scope={scope}>
      {fields.map((f) => {
        if (f.source === 'item') return null;
        if (f.source === 'default') return <DefaultField key={f.field} state={state} def={def} prop={f.prop} schema={f.schema} label={f.field === 'label' ? `${kind} text` : undefined} onChange={set(f, `Edit ${f.schema.label} default`)} />;
        const hint = sources.size > 1 ? 'Same in every placement.' : undefined;
        switch (f.field) {
          case 'text':
            return (
              <div key={f.field} data-field="text" style={{ display: 'contents' }}>
                <Field label="Text" hint={hint}>
                  <DraftInput multiline rows={2} value={Array.isArray(f.value) ? richTextToMarkdown(toRichText(f.value), state.pages) : String(f.value ?? '')} onCommit={(v) => void applyOps([designContentOp(def, node.id, 'text', v)], 'Edit definition text', `${def.id}:${node.id}:text`)} />
                </Field>
              </div>
            );
          case 'label':
            return (
              <div key={f.field} data-field="label" style={{ display: 'contents' }}>
                <Field label={`${kind} text`} hint={hint}>
                  <DraftInput value={String(f.value ?? '')} onCommit={(v) => void applyOps([designContentOp(def, node.id, 'label', v)], 'Edit button text everywhere', `${def.id}:${node.id}:label`)} />
                </Field>
              </div>
            );
          case 'link':
            // A destination fixed in the design: a button without one is left out of every placement.
            return (
              <div key={f.field} className="field" data-field="link" role="group" aria-labelledby={`${node.id}-def-dest`}>
                <div className="field-label" id={`${node.id}-def-dest`}>
                  Link
                </div>
                <LinkEditor value={f.value as LinkValue} onChange={set(f, 'Edit button link everywhere')} state={state} label={kind} everywhere />
                {hint && <div className="field-hint">{hint}</div>}
              </div>
            );
          case 'image':
            return (
              <div key={f.field} className="field" data-field="image" role="group" aria-label="Image">
                <ImageEditor value={f.value as ImageValue} onChange={set(f, 'Edit image everywhere')} state={state} />
                {hint && <div className="field-hint">{hint}</div>}
              </div>
            );
          case 'icon':
            return (
              <div key={f.field} data-field="icon" style={{ display: 'contents' }}>
                <Field label="Icon" controlId={iconId} hint={hint}>
                  <IconPicker id={iconId} value={String(f.value ?? '')} onChange={set(f, 'Edit icon everywhere')} />
                </Field>
              </div>
            );
        }
      })}
      {items.length > 0 && (
        <p className="muted insp-note">
          Each {list?.itemLabel.toLowerCase() ?? 'item'} has its own {listJoin(items.map((f) => FIELD_NAME[f.field]))}. Change {items.length === 1 ? 'it' : 'them'} in the {list?.label.toLowerCase() ?? 'items'} list of each placement.
        </p>
      )}
    </Section>
  );
}

/** A component placed in the design: the inputs the design gives it, the same in every placement. */
function NestedInputs({ state, def, node, placedDef }: { state: ProjectState; def: ComponentDefinition; node: InstanceNode; placedDef: ComponentDefinition }) {
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const fields = groupFields(Object.entries(placedDef.properties).map(([key, schema]) => ({ key, schema: schema as PropSchema, data: null })));
  if (!fields.length) return null;
  return (
    <Section title="Content" id="content" level={LEVEL} scope="Same in every placement">
      <FieldGroups
        groups={fields}
        render={({ key, schema, label }) => {
          const raw = node.props[key];
          const forwarded = forwardedProp(raw);
          if (forwarded) return <ForwardedDefault key={key} state={state} def={def} prop={forwarded} />;
          if (isBinding(raw))
            return (
              <p key={key} className="muted insp-note">
                {label ?? schema.label}: each item of the list has its own.
              </p>
            );
          return (
            <PropField
              key={key}
              name={key}
              schema={schema}
              label={label}
              value={raw ?? schema.default}
              onChange={(v, edit) => void applyWith(edit, [{ type: 'instance.setProp', owner, nodeId: node.id, prop: key, value: v }], `Edit ${schema.label} everywhere`, `${def.id}:${node.id}:${key}`)}
              onList={(op) => applyListOp(owner, node.id, key, op, `Edit ${schema.label} everywhere`, op.kind === 'field' ? `${def.id}:${node.id}:${key}:${op.itemId}:${op.field}` : undefined)}
              read={() => readProp(owner, node.id, key)}
              onTable={(edit) => applyTableEdit(owner, node.id, key, edit, `Edit ${schema.label} everywhere`)}
              state={state}
              linkPairs={schema.type === 'list' ? itemLinkPairs(placedDef, key) : undefined}
              everywhere
            />
          );
        }}
      />
    </Section>
  );
}

const listJoin = (items: string[]) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function DefinitionNodeInspector({ state, def, node, tokens }: { state: ProjectState; def: ComponentDefinition; node: GraphNode; tokens: Tokens }) {
  const scope = useStore((s) => s.styleScope);
  const devUrl = useDevUrl();
  const pageId = useStore((s) => s.pageId);
  const selection = useStore((s) => s.selection);
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
  // The picture as the canvas shows it, through this component's one placement on the page (with the item
  // picked there); else the design's own picture, or its default for one each placement chooses. With several
  // placements on the page the canvas's choice isn't known here, so the default stands. The crop follows the
  // node's complete styles: `changed` lists only what differs from the theme's design.
  const onPage = pageId ? placementsOn(state, def.id, pageId) : [];
  const placement = onPage.length === 1 ? onPage[0] : undefined;
  const bound = node.kind === 'image' && isBinding(node.image) ? node.image : undefined;
  const ownRef = selection?.owner.kind === 'component' && selection.owner.id === def.id && selection.nodeId === node.id ? selection : undefined;
  const placedImage = node.kind === 'image' && bound && placement && ownRef ? shownImage(state, throughPlacement(ownRef, placement), bound) : undefined;
  // That placement (or the variants it picks) may set its own crop over the design's.
  const placed = placement ? resolveRef(state, placement).node : undefined;
  const cropKeys = ['aspectRatio', 'objectFit', 'objectPosition'];
  const setsCrop = (rs: ResponsiveStyles | undefined) => Object.values(rs ?? {}).some((sc) => cropKeys.some((k) => sc?.[k] !== undefined));
  const placementCrops =
    placed?.kind === 'instance' && ((partId !== undefined && setsCrop(placed.overrides?.[partId])) || selectedVariantStyles(def, placed.variants, node.id).some(setsCrop));
  const defImage =
    node.kind === 'image'
      ? {
          ...focusImage(
            state,
            devUrl,
            placedImage ?? (!bound ? node.image : '$prop' in bound && Object.hasOwn(def.properties, bound.$prop) ? def.properties[bound.$prop].default : undefined),
            [],
            'Each one shows its own picture. Select one on the page to see it here.',
            node.styles ?? {}
          ),
          note: placementCrops ? 'The placement on this page sets its own crop, so the canvas may differ.' : undefined
        }
      : undefined;
  const placedDef = node.kind === 'instance' ? state.components[node.definitionId] : undefined;
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
        <EverywhereScope state={state} def={def} />
      </Header>
      <DesignContentSection state={state} def={def} node={node} />
      {/* A component placed in the design: what it is given here, the same in every placement. */}
      {node.kind === 'instance' && placedDef && <NestedInputs state={state} def={def} node={node} placedDef={placedDef} />}
      <Section title="Style" id="def-style" level={LEVEL} scope={repeated ? `Every ${itemWord ?? 'item'} · ${placements}` : placements}>
        {node.kind === 'instance' ? (
          <StyleControls
            styles={node.overrides?.root}
            inherited={placedDef?.kind === 'managed' && placedDef.tree ? designStyles(placedDef, placedDef.parts.root?.nodeId ?? placedDef.tree.rootIds[0], node.variants) : undefined}
            wideColumns
            tokens={tokens}
            allowed={placedDef?.parts.root?.styleControls ?? styleSetFor(node)}
            onSet={(property, value, expectedRevision) =>
              commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, partId: 'root', scope, property, value }], `Edit ${def.name} definition`, styleKey(property, `${def.id}:${node.id}:root:${scope}:${property}`), expectedRevision)
            }
            onReset={(sc) => void applyOps([{ type: 'node.resetStyles', owner, nodeId: node.id, partId: 'root', scope: sc }], 'Reset overrides')}
            target={`the ${(node.name ?? placedDef?.name ?? 'component').toLowerCase()} itself`}
          />
        ) : (
        <StyleControls
          styles={changed}
          inherited={original}
          designSizesWin
          tokens={tokens}
          allowed={styleSetFor(node)}
          image={defImage}
          onSet={(property, value, expectedRevision) => {
            // Resetting a value restores the original design's value, when there is one.
            const restore = value === null ? original?.[scope]?.[property] : undefined;
            return commitOps([{ type: 'node.setStyle', owner, nodeId: node.id, scope, property, value: restore ?? value }], `Edit ${def.name} definition`, styleKey(property, `${def.id}:${node.id}:${scope}:${property}`), expectedRevision);
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
        )}
      </Section>
    </>
  );
}

function PageSettings({ page, state }: { page: PageDoc; state: ProjectState }) {
  const previewing = useStore((s) => s.mode === 'preview');
  const assetSort = useStore((s) => s.assetSort);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const [titleError, setTitleError] = useState<string | null>(null);
  if (!page) return null;
  const upd = (patch: Record<string, unknown>, label = 'Update page settings') => void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], label);
  const isHome = page.id === state.site.homePageId;
  const draft = isDraftPage(state, page);
  // The sharing image menu lists images in the order Assets does, with the ID of any that share a name.
  const images = sortAssets(Object.values(state.assets.assets).filter((a) => a.kind === 'image'), assetSort);
  const imageLabels = assetLabels(images);
  return (
    <div className="panel-body insp">
      <Header title={page.title} kind={`${isHome ? 'Home page' : draft ? 'Draft page' : 'Page'} · ${isHome ? '/' : page.route}`} icon={isHome ? <House /> : <FileText />}>
        <Scope tone="local" icon={<MousePointerClick />}>
          {previewing ? 'Previewing. Page settings stay editable; switch to Edit to select things on the page.' : 'Nothing selected. Click anything on the page to edit it.'}
        </Scope>
      </Header>
      <Section title="Page" id="page-basic" level={LEVEL}>
        <Field label="Title" error={titleError}>
          <DraftInput
            value={page.title}
            onCommit={(v) => {
              if (!v.trim()) {
                setTitleError(`A page needs a title. Kept “${page.title}”.`);
                return false;
              }
              setTitleError(null);
              upd({ title: v.trim() }, 'Rename page');
            }}
          />
        </Field>
        <Field label="Address" hint={isHome ? 'The home page is always at /.' : 'Links to this page update automatically when you change it.'}>
          {isHome ? <input className="input" value="/" readOnly aria-label="Page address" /> : <DraftInput value={page.route} onCommit={(v) => upd({ route: v }, 'Change page address')} ariaLabel="Page address" />}
        </Field>
        {/* The Home page is the website's front door: it is always published. */}
        {!isHome && (
          <SwitchRow
            checked={draft}
            onChange={(v) => upd({ draft: v }, v ? 'Keep page as draft' : 'Publish page')}
            label="Keep as draft"
            hint={
              draft
                ? 'Left out of the website when you export it. You can still edit and preview it, and it stays in the editable project.'
                : 'Keep working on this page without publishing it. The website export leaves drafts out.'
            }
          />
        )}
      </Section>
      <Section title="Shared header and footer" id="page-shell" level={LEVEL} scope="This page only">
        <SwitchRow checked={showsPart(page, 'header')} onChange={(v) => upd({ showHeader: v }, v ? 'Show shared header on page' : 'Hide shared header on page')} label="Show shared header" />
        <SwitchRow checked={showsPart(page, 'footer')} onChange={(v) => upd({ showFooter: v }, v ? 'Show shared footer on page' : 'Hide shared footer on page')} label="Show shared footer" />
        <p className="insp-note field-hint">Other pages keep their own choice. Editing the header or footer changes it on every page that shows it.</p>
      </Section>
      <Section title="Search & sharing" id="page-seo" level={LEVEL}>
        <Field label="Browser title" hint={`Leave empty to use “${isHome ? state.site.name : `${page.title} · ${state.site.name}`}”.`}>
          <DraftInput value={page.seo.title ?? ''} onCommit={(v) => upd({ seoTitle: v }, 'Change browser title')} />
        </Field>
        <Field label="Description" hint="Shown by search engines. About 150 characters.">
          <DraftInput multiline value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onCommit={(v) => upd({ description: v }, 'Change page description')} />
        </Field>
        <Field label="Sharing image" hint="Shown when the page is shared, and on this page’s card in page lists. None uses the site’s sharing image when shared.">
          <select className="select" value={page.seo.socialImage ?? ''} onChange={(e) => upd({ socialImage: e.target.value || null }, 'Change sharing image')}>
            <option value="">None</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {imageLabels.get(a.id)?.label}
              </option>
            ))}
          </select>
        </Field>
        <SwitchRow
          checked={!!page.seo.noindex}
          onChange={(v) => upd({ noindex: v })}
          label="Hide from search engines"
          hint={
            draft
              ? 'Once the page is published, search engines are asked not to list it. Anyone with its address can still open it.'
              : 'The page is still published and anyone with its address can open it; search engines are only asked not to list it.'
          }
        />
        <SwitchRow checked={!!page.seo.searchHidden} onChange={(v) => upd({ searchHidden: v })} label="Hide from site search" hint="Leaves this page out of the results of the site’s own Site search section." />
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
