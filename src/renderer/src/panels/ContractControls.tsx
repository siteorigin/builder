/**
 * Edit everywhere's controls for a component's contract: which content each placement fills in, which inner elements
 * each placement may style, and the looks placements choose between. Each control plans its change from the project
 * as it is when the author acts (lib/component-contract) and sends it against that revision, so a change planned on a
 * project that has moved on since is refused rather than misapplied. Every change is one Undo.
 */
import { useId, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Paintbrush, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ComponentCategory, ComponentDefinition, GraphNode, PropSchema, SlotDef, SlotPrimitive } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES, isBinding } from '@shared/types';
import { propBindingSchema } from '@shared/bindings';
import { axesOf, selectedVariants } from '@shared/variants';
import { instancesOf } from '@engine/tree';
import { slotAccepts } from '@engine/slots';
import { applyOps, confirmDialog, getState, setState, toast, useStore } from '../store';
import { DraftInput, Field, Section, Segmented } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { designContent, type DesignContent } from '../lib/design-content';
import { nodeLabel, slotInsertAt } from '../lib/insert-at';
import {
  SLOT_CATEGORY_LABELS,
  SLOT_DESCRIPTION_MAX,
  SLOT_LABEL_MAX,
  SLOT_PRIMITIVE_LABELS,
  createSlotOps,
  declaredSlot,
  editSlotOp,
  placedSlots,
  removeSlotOp,
  slotDraft,
  slotDraftProblem,
  slotFilledIn,
  slotLimitWords,
  type SlotDraft
} from '../lib/slot-contract';
import {
  MAX_PROPERTIES,
  addVariantGroupOp,
  addVariantOp,
  bindChoices,
  bindExistingOp,
  bindNewProperty,
  canExposePart,
  defaultVariantOp,
  exposePartOp,
  liveStyleTarget,
  movePropOp,
  nodeName,
  partOf,
  placementOrder,
  propertyUses,
  removeVariantOp,
  renamePartOp,
  renamePropOp,
  renameVariantGroupOp,
  renameVariantOp,
  suggestedPropLabel,
  unbindOp,
  type BindChoice,
  type StyleTarget
} from '../lib/component-contract';

const FIELD_WORDS: Record<DesignContent['field'], string> = { text: 'text', label: 'text', link: 'link', image: 'image', icon: 'icon' };

/** The longest names the operations take (see ops.ts): a property's label, a part's or option's, a choice's. */
const PROPERTY_MAX = 80;
const NAME_MAX = 60;
const CHOICE_MAX = 40;

/** The definition and node as the project holds them now, for a change planned when the author acts. */
function current(defId: string, nodeId?: string): { snap: ProjectSnapshot; def: ComponentDefinition; node: GraphNode | undefined } | null {
  const snap = getState().snapshot;
  const def = snap?.state.components[defId];
  const node = nodeId ? def?.tree?.nodes[nodeId] : undefined;
  return snap && def ? { snap, def, node } : null;
}

/**
 * Apply a change planned on `planned`: refused if the project has moved on since, and never sent to another project
 * opened meanwhile (a confirmation left open while the project switched), which could share its IDs and revision.
 */
const apply = (operations: EditOperation[], label: string, planned: ProjectSnapshot) =>
  getState().snapshot?.workspaceKey === planned.workspaceKey ? applyOps(operations, label, undefined, planned.revision) : Promise.resolve(null);

/** Enter (not one that ends an input method's composition) and Escape, for a field that is not a DraftInput. */
const keys = (on: { enter?: () => void; escape?: () => void }) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (isImeComposing(e)) return;
  if (e.key === 'Enter') on.enter?.();
  if (e.key === 'Escape') on.escape?.();
};

const choiceKey = (c: BindChoice) => `${c.binding.$prop}:${c.binding.field ?? ''}`;

/** One field's content as the project holds it now: where it comes from, or null when the node or field is gone. */
const contentNow = (def: ComponentDefinition, node: GraphNode | undefined, field: DesignContent['field']) => (node ? (designContent(def, node).find((f) => f.field === field) ?? null) : null);

/**
 * Under one content field of a design's node: make a field fixed in the design one each placement fills in (a new
 * property, or one the component has), or make a filled-in field the same in every placement again.
 */
export function BindingControl({ def, node, content }: { def: ComponentDefinition; node: GraphNode; content: DesignContent }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const id = useId();
  const state = useStore((s) => s.snapshot?.state);
  if (content.source === 'item' || !state) return null;
  const field = content.field;
  const what = `${nodeName(node)} ${FIELD_WORDS[field]}`;
  const choices = bindChoices(state, def, node, field);
  const full = Object.keys(def.properties).length >= MAX_PROPERTIES;
  const create = async () => {
    const now = current(def.id, node.id);
    // Planned only while the field is still fixed in the design, as the form said.
    if (!now || contentNow(now.def, now.node, field)?.source !== 'design') return;
    const plan = bindNewProperty(now.snap.state, now.def, now.node!, field, label);
    if (!plan) return;
    if (await apply(plan.operations, `Fill in ${what.toLowerCase()} on each placement`, now.snap)) setOpen(false);
  };
  /** Whether the field still comes from where this control showed it coming from. */
  const unchanged = (now: ReturnType<typeof current>) => {
    const c = now && contentNow(now.def, now.node, field);
    return !!c && c.source === content.source && (c.source !== 'default' || content.source !== 'default' || c.prop === content.prop);
  };
  const use = async (key: string) => {
    const now = current(def.id, node.id);
    if (!now?.node || !unchanged(now)) return;
    // The property chosen, as the project has it now: one removed or retyped since the menu was drawn is not offered.
    const choice = bindChoices(now.snap.state, now.def, now.node, field).find((c) => choiceKey(c) === key);
    if (!choice) return;
    if (await apply([bindExistingOp(now.def, node.id, field, choice.binding)], `Show ${choice.label} in ${what.toLowerCase()}`, now.snap)) setOpen(false);
  };
  const chooser = choices.length > 0 && (
    <Field label={content.source === 'design' ? 'Or show a property it has' : 'Show another property'} controlId={`${id}-use`} hint="Each placement then shows its own value of that property.">
      <select id={`${id}-use`} className="select" aria-describedby={`${id}-use-note`} value="" onChange={(e) => e.target.value && void use(e.target.value)}>
        <option value="">Choose a property…</option>
        {choices.map((c) => (
          <option key={choiceKey(c)} value={choiceKey(c)}>
            {c.label}
          </option>
        ))}
      </select>
    </Field>
  );
  if (content.source === 'default') {
    const unbind = () => {
      const now = current(def.id, node.id);
      if (now && unchanged(now)) void apply([unbindOp(now.def, node.id, field)], `Make ${what.toLowerCase()} the same in every placement`, now.snap);
    };
    return (
      <div className="contract-bind" data-contract={field}>
        <div className="contract-bind-line">
          <span className="faint">Each placement fills in “{def.properties[content.prop]?.label ?? content.prop}”.</span>
          {choices.length > 0 && (
            <button className="insp-mini" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              Change…
            </button>
          )}
          <button className="insp-mini" onClick={unbind} title="Every placement shows what this shows now. The property and each placement’s own value stay, in case you need them again.">
            Same everywhere
          </button>
        </div>
        {open && <div className="contract-box">{chooser}</div>}
      </div>
    );
  }
  if (!open)
    return (
      <div className="contract-bind" data-contract={field}>
        <button
          className="insp-mini"
          onClick={() => {
            setLabel(suggestedPropLabel(def, node, field));
            setOpen(true);
          }}
        >
          <Plus aria-hidden="true" /> Fill in on each placement…
        </button>
      </div>
    );
  return (
    <div className="contract-box" role="group" aria-labelledby={`${id}-title`} data-contract={field}>
      <p className="insp-note" id={`${id}-title`}>
        <strong>Fill in {what.toLowerCase()} on each placement.</strong> Every placement starts with what it shows now, and can then change it in its Content.
      </p>
      {full ? (
        <p className="insp-note muted">
          {def.name} has {MAX_PROPERTIES} properties, the most it can have. Remove one, or show one it has.
        </p>
      ) : (
        <Field label="Property name">
          <input className="input" value={label} maxLength={PROPERTY_MAX} onChange={(e) => setLabel(e.target.value)} onKeyDown={keys({ enter: () => void create(), escape: () => setOpen(false) })} autoFocus />
        </Field>
      )}
      <div className="contract-actions">
        {!full && (
          <button className="btn btn-sm btn-primary" onClick={() => void create()}>
            Add property
          </button>
        )}
        <button className="btn btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {chooser}
    </div>
  );
}

/**
 * Under a tag each placement chooses (a choice property, or one field of an object property): make it the design's
 * own again, the one it shows now.
 */
export function TagBindingControl({ def, node, binding }: { def: ComponentDefinition; node: GraphNode; binding: { $prop: string; field?: string } }) {
  const same = (b: unknown) => isBinding(b) && '$prop' in b && b.$prop === binding.$prop && b.field === binding.field;
  const unbind = () => {
    const now = current(def.id, node.id);
    if (now && same((now.node as { tag?: unknown } | undefined)?.tag))
      void apply([{ type: 'node.setBinding', owner: { kind: 'component', id: def.id }, nodeId: node.id, field: 'tag', binding: null }], `Make ${nodeName(node).toLowerCase()} tag the same in every placement`, now.snap);
  };
  const label = propBindingSchema(def.properties, binding)?.label ?? binding.field ?? binding.$prop;
  return (
    <div className="contract-bind" data-contract="tag">
      <div className="contract-bind-line">
        <span className="faint">Each placement chooses its tag, as “{label}”.</span>
        <button className="insp-mini" onClick={unbind} title="Every placement uses the tag this default gives it now. The property stays, in case you need it again.">
          Same everywhere
        </button>
      </div>
    </div>
  );
}

const TYPE_WORDS: Record<string, string> = {
  string: 'Text',
  richtext: 'Formatted text',
  number: 'Number',
  boolean: 'Yes or no',
  enum: 'Choice',
  choices: 'Choices',
  link: 'Link',
  image: 'Image',
  icon: 'Icon',
  list: 'List',
  table: 'Table',
  object: 'Group of fields',
  token: 'Site style'
};

const LEVEL_NOTE = 'Heading levels come after the content on every placement';

/** The component's properties, in the order each placement's Content lists them: rename, reorder or remove them. */
export function PropertiesSection({ def, level }: { def: ComponentDefinition; level: number }) {
  const entries = placementOrder(def).map((k) => [k, def.properties[k]] as [string, PropSchema]);
  const move = (prop: string, delta: -1 | 1) => {
    const now = current(def.id);
    const op = now && movePropOp(now.def, prop, delta);
    if (op) void apply([op], `Move ${now.def.properties[prop].label} ${delta < 0 ? 'up' : 'down'}`, now.snap);
  };
  const remove = async (prop: string) => {
    // What the dialog says is what is removed: planned once, and refused if the project changes while it is open.
    const now = current(def.id);
    const schema = now?.def.properties[prop];
    if (!now || !schema || propertyUses(now.def, prop).length) return;
    const holding = instancesOf(now.snap.state, def.id).filter((p) => Object.hasOwn(p.node.props, prop)).length;
    if (holding) {
      const ok = await confirmDialog({
        title: `Remove “${schema.label}”?`,
        body: `${holding === 1 ? 'One placement has' : `${holding} placements have`} a value for it, which ${holding === 1 ? 'goes' : 'go'} with it. Undo brings ${holding === 1 ? 'it' : 'them'} back.`,
        confirmLabel: 'Remove',
        tone: 'caution'
      });
      if (!ok) return;
    }
    void apply([{ type: 'component.removePropSchema', definitionId: def.id, prop }], `Remove ${schema.label} property`, now.snap);
  };
  return (
    <Section title="Properties" id="def-properties" level={level} scope={entries.length ? `${entries.length} filled in on each placement` : undefined}>
      {entries.length === 0 ? (
        <p className="insp-note muted">Every placement shows the same content. To let each placement fill something in, select a heading, text, image, button or icon and choose Fill in on each placement.</p>
      ) : (
        <ul className="contract-list" aria-label={`Properties of ${def.name}`}>
          {entries.map(([prop, schema], i) => {
            const uses = propertyUses(def, prop);
            const up = movePropOp(def, prop, -1);
            const down = movePropOp(def, prop, 1);
            return (
              <li key={prop} className="contract-row" data-prop={prop}>
                <div className="contract-row-main">
                  <DraftInput
                    className="sm"
                    value={schema.label}
                    limit={PROPERTY_MAX}
                    ariaLabel={`Name of the ${schema.label} property`}
                    onCommit={(v) => {
                      if (!v.trim()) return false;
                      const now = current(def.id);
                      const op = now && renamePropOp(now.def, prop, v);
                      if (op) void apply([op], `Rename ${schema.label} property`, now.snap);
                    }}
                  />
                  <span className="faint contract-meta">
                    {TYPE_WORDS[schema.type] ?? schema.type} · {uses.length ? `shown by ${uses.join(', ')}` : 'not shown in the design'}
                  </span>
                </div>
                <button className="icon-btn sm" disabled={!up} aria-label={`Move ${schema.label} up`} title={i > 0 && !up ? LEVEL_NOTE : 'Move up'} onClick={() => move(prop, -1)}>
                  <ArrowUp />
                </button>
                <button className="icon-btn sm" disabled={!down} aria-label={`Move ${schema.label} down`} title={i < entries.length - 1 && !down ? LEVEL_NOTE : 'Move down'} onClick={() => move(prop, 1)}>
                  <ArrowDown />
                </button>
                <button
                  className="icon-btn sm"
                  aria-disabled={uses.length > 0}
                  aria-label={`Remove ${schema.label}`}
                  title={uses.length ? `Shown by ${uses.join(', ')}. Change ${uses.length === 1 ? 'that' : 'those'} first, so the design no longer shows it.` : 'Remove'}
                  onClick={() => uses.length === 0 && void remove(prop)}
                >
                  <Trash2 />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** Whether placements may style a node of the design on their own, as a named part. */
export function PartSection({ def, node, level }: { def: ComponentDefinition; node: GraphNode; level: number }) {
  const id = useId();
  const found = partOf(def, node.id);
  const isRoot = def.tree?.rootIds[0] === node.id;
  if (isRoot || (!found && !canExposePart(def, node))) return null;
  const expose = () => {
    const now = current(def.id, node.id);
    if (now?.node && canExposePart(now.def, now.node)) void apply([exposePartOp(now.snap.state, now.def, now.node, nodeName(now.node))], `Let placements style ${nodeName(node)}`, now.snap);
  };
  const remove = async () => {
    const now = current(def.id);
    const part = now && found && partOf(now.def, node.id);
    if (!now || !part) return;
    const styled = instancesOf(now.snap.state, def.id).filter((p) => (p.node.overrides && Object.hasOwn(p.node.overrides, part.id)) || (p.node.itemOverrides && Object.hasOwn(p.node.itemOverrides, part.id))).length;
    if (styled) {
      const ok = await confirmDialog({
        title: `Stop styling “${part.part.label}” on placements?`,
        body: `${styled === 1 ? 'One placement styles' : `${styled} placements style`} it on its own. Those styles go, and it looks as the design has it. Undo brings them back.`,
        confirmLabel: 'Stop',
        tone: 'caution'
      });
      if (!ok) return;
    }
    void apply([{ type: 'component.removePart', definitionId: def.id, partId: part.id }], `Stop styling ${part.part.label} on placements`, now.snap);
  };
  return (
    <Section title="On each placement" id="def-part" level={level} scope={found ? `Styled as “${found.part.label}”` : 'Same in every placement'}>
      {found ? (
        <>
          <Field label="Part name" controlId={`${id}-part`} hint="Each placement can style this on its own, under this name in its Style section.">
            <DraftInput
              id={`${id}-part`}
              aria-describedby={`${id}-part-note`}
              value={found.part.label}
              limit={NAME_MAX}
              onCommit={(v) => {
                if (!v.trim()) return false;
                const now = current(def.id);
                const op = now && renamePartOp(now.def, found.id, v);
                if (op) void apply([op], `Rename ${found.part.label} part`, now.snap);
              }}
            />
          </Field>
          <button className="btn btn-sm" onClick={() => void remove()}>
            Stop styling it on placements
          </button>
        </>
      ) : (
        <>
          <p className="insp-note muted">Its style is the same in every placement. Let each placement restyle it on its own, as a named part.</p>
          <button className="btn btn-sm" onClick={expose}>
            <Paintbrush aria-hidden="true" /> Let each placement style this
          </button>
        </>
      )}
    </Section>
  );
}

/**
 * The variant option Edit everywhere styles, still one the component has. The store forgets one that is gone (an
 * Undo, a removal), so an option made again later under the same ID is not styled without being chosen.
 */
export function useVariantStyle(def: ComponentDefinition): StyleTarget {
  const stored = useStore((s) => (s.variantStyle?.definitionId === def.id ? s.variantStyle : null));
  return liveStyleTarget(def, stored ? { axis: stored.axis, variant: stored.variant } : null);
}

export const styleVariant = (def: ComponentDefinition, target: StyleTarget) => setState({ variantStyle: target ? { definitionId: def.id, ...target } : null });

/** A one-line add: text and a button. */
function AddRow({ label, placeholder, onAdd }: { label: string; placeholder: string; onAdd: (text: string) => Promise<unknown> | null }) {
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    if ((await onAdd(text)) !== null) setText('');
  };
  return (
    <div className="contract-add">
      <input className="input sm" value={text} placeholder={placeholder} aria-label={label} maxLength={NAME_MAX} onChange={(e) => setText(e.target.value)} onKeyDown={keys({ enter: () => void add() })} />
      <button className="btn btn-sm" disabled={!text.trim()} onClick={() => void add()}>
        <Plus aria-hidden="true" /> Add
      </button>
    </div>
  );
}

/** The looks placements choose between, by group: add, rename, make default, remove, and pick one to style. */
export function VariantsSection({ def, level, onStyle }: { def: ComponentDefinition; level: number; onStyle: (target: StyleTarget) => void }) {
  const id = useId();
  const [group, setGroup] = useState('');
  const [first, setFirst] = useState('');
  const axes = axesOf(def);
  const target = useVariantStyle(def);
  const run = (plan: (d: ComponentDefinition, snap: ProjectSnapshot) => EditOperation | null, label: string) => {
    const now = current(def.id);
    const op = now && plan(now.def, now.snap);
    return op ? apply([op], label, now.snap) : null;
  };
  const addGroup = async () => {
    if (!group.trim() || !first.trim()) return;
    if (await run((d, snap) => addVariantGroupOp(snap.state, d, group, first), `Add ${group.trim()} variants`)) {
      setGroup('');
      setFirst('');
    }
  };
  const remove = async (axis: string, option: string, label: string) => {
    // Counted and sent from one reading of the project: a placement that changes while the dialog is open refuses it.
    const now = current(def.id);
    const a = now && axesOf(now.def).find(([x]) => x === axis)?.[1];
    if (!now || !a || !Object.hasOwn(a.options, option)) return;
    const showing = instancesOf(now.snap.state, def.id).filter((p) => selectedVariants(now.def, p.node.variants)[axis] === option).length;
    const rest = Object.keys(a.options).filter((o) => o !== option);
    if (showing) {
      const after = rest.length ? `the ${a.label.toLowerCase()} default, ${a.options[a.default === option ? rest[0] : a.default].label}, instead` : `no ${a.label.toLowerCase()} at all, since it is the last option`;
      const ok = await confirmDialog({
        title: `Remove “${label}”?`,
        body: `${showing === 1 ? 'One placement shows' : `${showing} placements show`} it, and will show ${after}. Undo brings it back.`,
        confirmLabel: 'Remove',
        tone: 'caution'
      });
      if (!ok) return;
    }
    void apply([removeVariantOp(now.def, axis, option)], `Remove ${label} variant`, now.snap);
  };
  return (
    <Section title="Variants" id="def-variants" level={level} scope={axes.length ? `${axes.length === 1 ? '1 choice' : `${axes.length} choices`} on each placement` : undefined}>
      <p className="insp-note muted">Looks each placement chooses between, such as a dark tone or a wide layout. Style one with the paintbrush, or under Style.</p>
      {axes.map(([axis, a]) => (
        <div key={axis} className="contract-group" role="group" aria-label={a.label} data-axis={axis}>
          <Field label="Choice" controlId={`${id}-${axis}`}>
            <DraftInput
              id={`${id}-${axis}`}
              value={a.label}
              limit={CHOICE_MAX}
              onCommit={(v) => {
                if (!v.trim()) return false;
                void run((d) => renameVariantGroupOp(d, axis, v), `Rename ${a.label} variants`);
              }}
            />
          </Field>
          <ul className="contract-list" aria-label={`${a.label} options`}>
            {Object.entries(a.options).map(([option, o]) => {
              const styling = target?.axis === axis && target.variant === option;
              return (
                <li key={option} className="contract-row" data-variant={option}>
                  <div className="contract-row-main">
                    <DraftInput
                      className="sm"
                      value={o.label}
                      limit={NAME_MAX}
                      ariaLabel={`Name of the ${o.label} option`}
                      onCommit={(v) => {
                        if (!v.trim()) return false;
                        void run((d) => renameVariantOp(d, axis, option, v), `Rename ${o.label} variant`);
                      }}
                    />
                    <span className="faint contract-meta">
                      {a.default === option ? (
                        'Default'
                      ) : (
                        <button className="link-btn" onClick={() => void run((d) => defaultVariantOp(d, axis, option), `Make ${o.label} the default`)}>
                          Make default
                        </button>
                      )}
                      {o.styles && Object.keys(o.styles).length ? ' · styled' : ''}
                    </span>
                  </div>
                  <button className="icon-btn sm" aria-pressed={styling} aria-label={`Style ${o.label}`} title={styling ? 'Styling this look' : 'Style this look'} onClick={() => onStyle(styling ? null : { axis, variant: option })}>
                    <Paintbrush />
                  </button>
                  <button className="icon-btn sm" aria-label={`Remove ${o.label}`} title="Remove" onClick={() => void remove(axis, option, o.label)}>
                    <Trash2 />
                  </button>
                </li>
              );
            })}
          </ul>
          <AddRow label={`New ${a.label.toLowerCase()} option`} placeholder="New option" onAdd={(text) => run((d, snap) => addVariantOp(snap.state, d, axis, text), `Add ${text.trim()} variant`)} />
        </div>
      ))}
      <div className="contract-group" role="group" aria-label="New choice">
        <div className="field-label">{axes.length ? 'Another choice' : 'New choice'}</div>
        <div className="contract-add">
          <input className="input sm" value={group} placeholder="Choice, e.g. Tone" aria-label="Name of the choice" maxLength={CHOICE_MAX} onChange={(e) => setGroup(e.target.value)} />
          <input className="input sm" value={first} placeholder="Option, e.g. Dark" aria-label="Its first option" maxLength={NAME_MAX} onChange={(e) => setFirst(e.target.value)} onKeyDown={keys({ enter: () => void addGroup() })} />
          <button className="btn btn-sm" disabled={!group.trim() || !first.trim()} onClick={() => void addGroup()}>
            <Plus aria-hidden="true" /> Add
          </button>
        </div>
        <p className="insp-note faint">Placements keep their look: each starts on Default until it picks another.</p>
      </div>
    </Section>
  );
}

/** A design node as a selection of the component's own design, for where a new slot goes. */
const designRef = (def: ComponentDefinition, node: GraphNode | undefined) => (node ? { owner: { kind: 'component' as const, id: def.id }, instancePath: [], nodeId: node.id } : null);

/**
 * The places where each placement puts content of its own: declare one (with its placeholder inside the selected
 * container, or the whole design, in one Undo), change its name, what it takes and how many, and remove one no
 * placement fills. The engine refuses a contract that content placements already hold no longer fits, or removing a
 * slot that holds content, and says where; the form keeps what the author chose until it saves.
 */
export function SlotsSection({ def, node, level }: { def: ComponentDefinition; node?: GraphNode; level: number }) {
  const state = useStore((s) => s.snapshot?.state);
  if (def.kind !== 'managed' || !def.tree || !state) return null;
  const names = Object.keys(def.slots ?? {});
  const placed = placedSlots(def);
  return (
    <Section title="Slots" id="def-slots" level={level} scope={names.length ? (names.length === 1 ? '1 slot' : `${names.length} slots`) : undefined}>
      <p className="insp-note muted">Places where each placement puts content of its own, such as a card’s body or a hero’s buttons. Choose what each takes and how many.</p>
      {names.map((name) => (
        <SlotGroup key={name} def={def} name={name} decl={def.slots![name]} placedAt={placed.get(name)} filledIn={slotFilledIn(state, def, name)} />
      ))}
      <NewSlot def={def} node={node} />
    </Section>
  );
}

function SlotGroup({ def, name, decl, placedAt, filledIn }: { def: ComponentDefinition; name: string; decl: SlotDef; placedAt?: string; filledIn: string[] }) {
  const [editing, setEditing] = useState(false);
  const places = [...new Set(filledIn)];
  const shown = placedAt ? 'In the design' : 'Not in the design yet: add it from Insert';
  const filled = places.length ? `Holds content on ${places.join(', ')}` : 'Empty on every placement';
  const remove = () => {
    const now = current(def.id);
    // Sent even while it holds content: the engine then says which placements hold it.
    if (now && declaredSlot(now.def, name)) void apply([removeSlotOp(now.def, name)], `Remove ${decl.label} slot`, now.snap);
  };
  return (
    <div className="contract-group" role="group" aria-label={decl.label} data-slot={name}>
      <div className="contract-row">
        <div className="contract-row-main">
          <strong className="slot-name">{decl.label}</strong>
          {decl.description && <span className="faint contract-meta">{decl.description}</span>}
          <span className="faint contract-meta" data-slot-accepts>
            Takes {slotAccepts(decl)} · {slotLimitWords(decl)}
          </span>
          <span className="faint contract-meta">
            {shown} · {filled}
          </span>
        </div>
        <button className="icon-btn sm" aria-expanded={editing} aria-label={`Edit ${decl.label}`} title="Change what it takes" onClick={() => setEditing((o) => !o)}>
          <Pencil />
        </button>
        <button className="icon-btn sm" aria-label={`Remove ${decl.label}`} title={places.length ? `${filled}. Move or remove that content first.` : 'Remove, with its place in the design'} onClick={remove}>
          <Trash2 />
        </button>
      </div>
      {editing && <SlotForm def={def} name={name} decl={decl} onDone={() => setEditing(false)} />}
    </div>
  );
}

const SLOT_CATEGORIES = COMPONENT_CATEGORIES.filter((c): c is ComponentCategory => !!SLOT_CATEGORY_LABELS[c]);

/**
 * One slot's contract, changed together and saved once, so checking several kinds never sends a contract on the way
 * that content would refuse. A refused save keeps the form as the author left it, beside the engine's reason.
 */
function SlotForm({ def, name, decl, onDone }: { def: ComponentDefinition; name: string; decl: SlotDef; onDone: () => void }) {
  const id = useId();
  // What the slot was when the form opened: a save after it changed elsewhere (an Undo) asks the author to look again.
  const [base, setBase] = useState<SlotDef>(decl);
  const [draft, setDraft] = useState<SlotDraft>(() => slotDraft(decl));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const problem = slotDraftProblem(draft);
  const set = (patch: Partial<SlotDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const toggle = <T extends string>(list: T[], value: T, on: boolean) => (on ? [...list.filter((x) => x !== value), value] : list.filter((x) => x !== value));
  const save = async () => {
    setTried(true);
    if (problem || saving) return;
    const now = current(def.id);
    const d = now && declaredSlot(now.def, name);
    if (!now || !d) return void toast(`The “${base.label}” slot has been removed, so there is nothing to save. Undo brings it back.`, 'error');
    if (JSON.stringify(slotDraft(d)) !== JSON.stringify(slotDraft(base))) {
      setBase(d);
      return void toast(`“${d.label}” changed while you were editing it. Check the form, then save again.`, 'info');
    }
    const op = editSlotOp(now.def, name, draft);
    if (!op) return onDone();
    setSaving(true);
    const done = await apply([op], `Change ${d.label} slot`, now.snap);
    setSaving(false);
    if (done) onDone();
  };
  const kindBox = <T extends string>(legend: string, all: readonly T[], words: Partial<Record<T, string>>, chosen: T[], key: 'categories' | 'primitives') => (
    <fieldset className="slot-kinds">
      <legend className="field-label">{legend}</legend>
      {all.map((k) => (
        <label key={k}>
          <input type="checkbox" checked={chosen.includes(k)} onChange={(e) => set({ [key]: toggle(chosen, k, e.target.checked) } as Partial<SlotDraft>)} />
          <span>{words[k] ?? k}</span>
        </label>
      ))}
    </fieldset>
  );
  return (
    <div className="contract-box" role="group" aria-labelledby={`${id}-title`} data-slot-form={name}>
      <p className="insp-note" id={`${id}-title`}>
        <strong>What “{base.label}” takes</strong>
      </p>
      <Field label="Name">
        <input className="input" value={draft.label} maxLength={SLOT_LABEL_MAX} onChange={(e) => set({ label: e.target.value })} onKeyDown={keys({ enter: () => void save(), escape: onDone })} autoFocus />
      </Field>
      <Field label="What belongs there" hint="For you and the AI, when filling it in.">
        <textarea className="textarea" rows={2} value={draft.description} maxLength={SLOT_DESCRIPTION_MAX} onChange={(e) => set({ description: e.target.value })} />
      </Field>
      <Field label="Takes">
        <Segmented
          radio
          label="What it takes"
          value={draft.restricted ? 'some' : 'any'}
          options={[
            { value: 'any', label: 'Anything' },
            { value: 'some', label: 'Only what’s checked' }
          ]}
          onChange={(v) => set({ restricted: v === 'some' })}
        />
      </Field>
      {draft.restricted && (
        <>
          {kindBox<ComponentCategory>('Components', SLOT_CATEGORIES, SLOT_CATEGORY_LABELS, draft.categories, 'categories')}
          {kindBox<SlotPrimitive>('Elements', SLOT_PRIMITIVES, SLOT_PRIMITIVE_LABELS, draft.primitives, 'primitives')}
          {!draft.categories.length && !draft.primitives.length && <p className="insp-note muted">Nothing checked: the slot takes nothing.</p>}
        </>
      )}
      <Field label="Holds at most" hint="Blank for no limit. 0 keeps it empty.">
        <input className="input" inputMode="numeric" placeholder="No limit" value={draft.max} maxLength={4} onChange={(e) => set({ max: e.target.value })} onKeyDown={keys({ enter: () => void save(), escape: onDone })} />
      </Field>
      {tried && problem && (
        <p className="field-error" role="alert">
          {problem}
        </p>
      )}
      <div className="contract-actions">
        <button className="btn btn-sm btn-primary" disabled={saving} onClick={() => void save()}>
          Save
        </button>
        <button className="btn btn-sm" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Declare a new slot, with its placeholder where slotInsertAt puts it for the node the Inspector shows. */
function NewSlot({ def, node }: { def: ComponentDefinition; node?: GraphNode }) {
  const [label, setLabel] = useState('');
  const state = useStore((s) => s.snapshot?.state);
  const at = state ? slotInsertAt(state, def.id, designRef(def, node)) : null;
  const where = state && at?.parentId ? nodeLabel(state, at.owner, at.parentId) : null;
  const add = async () => {
    const now = current(def.id, node?.id);
    // Planned where the project has it now: the node may have gone, and the design's root then takes the slot.
    const place = now && slotInsertAt(now.snap.state, def.id, designRef(now.def, now.node));
    const plan = place && createSlotOps(now.snap.state, now.def, label, place);
    if (!now || !plan) return;
    if (await apply(plan.operations, `Add ${label.trim()} slot`, now.snap)) setLabel('');
  };
  return (
    <div className="contract-group" role="group" aria-label="New slot">
      <div className="field-label">{Object.keys(def.slots ?? {}).length ? 'Another slot' : 'New slot'}</div>
      <div className="contract-add">
        <input className="input sm" value={label} placeholder="Slot, e.g. Buttons" aria-label="Name of the new slot" maxLength={SLOT_LABEL_MAX} disabled={!at} onChange={(e) => setLabel(e.target.value)} onKeyDown={keys({ enter: () => void add() })} />
        <button className="btn btn-sm" disabled={!at || !label.trim()} onClick={() => void add()}>
          <Plus aria-hidden="true" /> Add slot
        </button>
      </div>
      <p className="insp-note faint" data-slot-where>
        {where ? `It goes inside ${where}, and takes anything until you choose.` : 'Select a container in the design that holds other elements, to put the slot in.'}
      </p>
    </div>
  );
}

/**
 * Which look the Style section styles: the base design, or one option of a choice. Disabled, with the reason, for a
 * node no look can style (a repeat or a slot), whatever look is chosen.
 */
export function StyleTargetField({ def, target, disabledReason }: { def: ComponentDefinition; target: StyleTarget; disabledReason?: string }) {
  const id = useId();
  const axes = axesOf(def);
  if (!axes.length) return null;
  const value = target && !disabledReason ? `${target.axis}:${target.variant}` : '';
  const hint = disabledReason ?? (target ? 'Only placements showing this look get these styles.' : undefined);
  return (
    <Field label="Styling" controlId={id} hint={hint}>
      <select
        id={id}
        className="select"
        aria-describedby={hint ? `${id}-note` : undefined}
        value={value}
        disabled={!!disabledReason}
        onChange={(e) => {
          const [axis, variant] = e.target.value.split(':');
          styleVariant(def, e.target.value ? { axis, variant } : null);
        }}
      >
        <option value="">Base design</option>
        {axes.map(([axis, a]) => (
          <optgroup key={axis} label={a.label}>
            {Object.entries(a.options).map(([option, o]) => (
              <option key={option} value={`${axis}:${option}`}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </Field>
  );
}
