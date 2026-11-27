/**
 * Edit everywhere's controls for a component's contract: which content each placement fills in, which inner elements
 * each placement may style, and the looks placements choose between. Each control plans its change from the project
 * as it is when the author acts (lib/component-contract) and sends it against that revision, so a change planned on a
 * project that has moved on since is refused rather than misapplied. Every change is one Undo.
 */
import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Paintbrush, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ComponentCategory, ComponentDefinition, GraphNode, ProjectState, PropSchema, SlotDef, SlotPrimitive } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES, isBinding } from '@shared/types';
import { propBindingSchema } from '@shared/bindings';
import { axesOf, selectedVariants } from '@shared/variants';
import { instancesOf } from '@engine/tree';
import { slotAccepts, slotDeclProblem } from '@engine/slots';
import { applyOps, claimRefusals, confirmDialog, getState, setState, toast, useStore } from '../store';
import { isRequiredRefusal } from '@shared/required';
import { Disclosure, DraftInput, Field, Section, Segmented, Switch } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { designContent, type DesignContent } from '../lib/design-content';
import { planSlotRemoval } from '../lib/removal-review';
import { nodeLabel, slotInsertAt, type InsertAt } from '../lib/insert-at';
import {
  SLOT_CATEGORY_LABELS,
  SLOT_DESCRIPTION_MAX,
  SLOT_LABEL_MAX,
  SLOT_NO_PLACE,
  SLOT_PRIMITIVE_LABELS,
  createSlotOps,
  declaredSlot,
  editSlotOp,
  placedSlots,
  rebaseSlotDraft,
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
  canRequire,
  isRequired,
  placementsMissing,
  requirableFields,
  setRequiredOp,
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

/** A section's summary: how many it holds, in plain words ("1 slot", "5 properties"). */
const tally = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Where a Required switch is: a property, or one field of a list or an object. */
type RequiredAt = { prop: string; field?: string };
const requiredKey = (at: RequiredAt) => `${at.prop}:${at.field ?? ''}`;

/**
 * Whether a property, or one of its fields, must be filled in on every placement. Absent for a type that always holds a
 * value and for a computed list's fields, unless already on (a hand edit), so it can be turned off. Read-only, it only
 * says so.
 */
function RequiredSwitch({ schema, at, name, readOnly, describedBy, onChange }: { schema: PropSchema; at: RequiredAt; name: string; readOnly: boolean; describedBy?: string; onChange: (on: boolean) => void }) {
  const id = useId();
  const on = isRequired(schema, at.field);
  if (!on && !canRequire(schema, at.field)) return null;
  if (readOnly) return on ? <span className="contract-required">Required</span> : null;
  // The visible word is the switch's label, and clicking it toggles the switch; the switch's own name says whose it is.
  return (
    <span className="contract-required">
      <label htmlFor={id}>Required</label>
      <Switch id={id} checked={on} onChange={onChange} label={`${name} required`} describedBy={describedBy} />
    </span>
  );
}

/** The component's properties, in the order each placement's Content lists them: rename, reorder, require or remove them. */
export function PropertiesSection({ def, level }: { def: ComponentDefinition; level: number }) {
  const id = useId();
  const entries = placementOrder(def).map((k) => [k, def.properties[k]] as [string, PropSchema]);
  const readOnly = useStore((s) => !!s.snapshot?.readOnly);
  // What the last Required switch did, said beside it until another is used: the placements it left missing a value
  // (while the rule is still there: an Undo takes the note away with it), or why it was refused.
  const [said, setSaid] = useState<{ key: string; text: string; refused?: true } | null>(null);
  const require = async (at: RequiredAt, on: boolean) => {
    const now = current(def.id);
    const op = now && setRequiredOp(now.def, at.prop, at.field, on);
    if (!now || !op) return;
    setSaid(null);
    const key = requiredKey(at);
    const schema = now.def.properties[at.prop];
    const label = at.field !== undefined && (schema.type === 'list' || schema.type === 'object') ? schema.fields[at.field].label : schema.label;
    // Counted on the project the change is planned on, which it applies to or is refused for.
    const count = on ? placementsMissing(now.snap.state, now.def, at.prop, at.field) : 0;
    // Refused because the default itself is empty, say: said here, by the switch, rather than in a toast.
    const done = await claimRefusals(
      (e) => {
        if (!isRequiredRefusal(e.details)) return false;
        setSaid({ key, text: e.message, refused: true });
        return true;
      },
      () => apply([op], `${on ? 'Require' : 'Stop requiring'} ${label}`, now.snap)
    );
    if (done && count) setSaid({ key, text: `${count === 1 ? 'One placement is' : `${count} placements are`} missing ${label} now.` });
  };
  // The note a Required switch's last use left, while it shows: the switch is described by it.
  const saidId = (at: RequiredAt) => `${id}-said-${requiredKey(at)}`;
  const saidFor = (at: RequiredAt, schema: PropSchema) => (said?.key === requiredKey(at) && (said.refused || isRequired(schema, at.field)) ? saidId(at) : undefined);
  const missingNote = (at: RequiredAt, schema: PropSchema) => {
    if (said?.key !== requiredKey(at)) return null;
    if (said.refused)
      return (
        <p className="contract-meta field-error contract-missing" role="alert" id={saidId(at)}>
          {said.text}
        </p>
      );
    if (!isRequired(schema, at.field)) return null;
    return (
      <p className="contract-meta contract-missing" role="status" id={saidId(at)}>
        {said.text}{' '}
        <button className="link-btn" onClick={() => setState({ modal: { kind: 'health' } })}>
          Open Project health
        </button>
      </p>
    );
  };
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
  const anyShown = entries.some(([prop]) => propertyUses(def, prop).length > 0);
  const shownNote = `${id}-shown`;
  const levelNote = `${id}-levels`;
  // A move the heading-level rule blocks (not the first row's up or the last row's down) says why, under the list.
  const levelBlocked = entries.some(([prop], i) => (i > 0 && !movePropOp(def, prop, -1)) || (i < entries.length - 1 && !movePropOp(def, prop, 1)));
  return (
    <Section title="Properties" id="def-properties" level={level} scope={entries.length ? tally(entries.length, 'property', 'properties') : undefined}>
      {entries.length === 0 ? (
        <p className="insp-note muted">Every placement shows the same content. To let each placement fill something in, select a heading, text, image, button or icon and choose Fill in on each placement.</p>
      ) : (
        <ul className="contract-list" aria-label={`Properties of ${def.name}`}>
          {entries.map(([prop, schema], i) => {
            const uses = propertyUses(def, prop);
            const up = movePropOp(def, prop, -1);
            const down = movePropOp(def, prop, 1);
            return (
              <li key={prop} className="contract-item" data-prop={prop}>
                <div className="contract-row">
                  <div className="contract-row-main">
                    <DraftInput
                      className="input sm"
                      value={schema.label}
                      limit={PROPERTY_MAX}
                      quietCount
                      ariaLabel={`Name of the ${schema.label} property`}
                      onCommit={(v) => {
                        if (!v.trim()) return false;
                        const now = current(def.id);
                        const op = now && renamePropOp(now.def, prop, v);
                        if (op) void apply([op], `Rename ${schema.label} property`, now.snap);
                      }}
                    />
                  </div>
                  <RowActions label={`Actions for ${schema.label}`}>
                  <button
                    className="icon-btn sm"
                    aria-disabled={!up || undefined}
                    aria-describedby={i > 0 && !up ? levelNote : undefined}
                    aria-label={`Move ${schema.label} up`}
                    title="Move up"
                    onClick={() => up && move(prop, -1)}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-disabled={!down || undefined}
                    aria-describedby={i < entries.length - 1 && !down ? levelNote : undefined}
                    aria-label={`Move ${schema.label} down`}
                    title="Move down"
                    onClick={() => down && move(prop, 1)}
                  >
                    <ArrowDown />
                  </button>
                  <button
                    className="icon-btn sm"
                    aria-disabled={uses.length > 0}
                    aria-describedby={uses.length ? shownNote : undefined}
                    aria-label={`Remove ${schema.label}`}
                    title={uses.length ? `Shown by ${uses.join(', ')}. Change ${uses.length === 1 ? 'that' : 'those'} first, so the design no longer shows it.` : 'Remove'}
                    onClick={() => uses.length === 0 && void remove(prop)}
                  >
                    <Trash2 />
                  </button>
                  </RowActions>
                </div>
                <div className="contract-row-line">
                  <span className="contract-meta">
                    {TYPE_WORDS[schema.type] ?? schema.type} · {uses.length ? `shown by ${uses.join(', ')}` : <span className="contract-flag">not shown in the design</span>}
                  </span>
                  <RequiredSwitch schema={schema} at={{ prop }} name={schema.label} readOnly={readOnly} describedBy={saidFor({ prop }, schema)} onChange={(on) => void require({ prop }, on)} />
                </div>
                {missingNote({ prop }, schema)}
                {requirableFields(schema).length > 0 && (
                  <Disclosure className="contract-fields" summary={`${schema.type === 'list' ? `${schema.itemLabel} fields` : 'Fields'} (${requirableFields(schema).length})`}>
                    <ul className="contract-list" aria-label={`Fields of ${schema.label}`}>
                      {requirableFields(schema).map(([field, fs]) => (
                        <li key={field} className="contract-field" data-field={field}>
                          <span className="contract-field-name">
                            {fs.label} <span className="faint">· {TYPE_WORDS[fs.type] ?? fs.type}</span>
                          </span>
                          <RequiredSwitch schema={schema} at={{ prop, field }} name={`${schema.label} → ${fs.label}`} readOnly={readOnly} describedBy={saidFor({ prop, field }, schema)} onChange={(on) => void require({ prop, field }, on)} />
                          {missingNote({ prop, field }, schema)}
                        </li>
                        ))}
                      </ul>
                    </Disclosure>
                  )}
              </li>
            );
          })}
        </ul>
      )}
      {anyShown && (
        <p className="insp-note muted" id={shownNote}>
          To remove a property the design shows, first change what shows it.
        </p>
      )}
      {levelBlocked && (
        <p className="insp-note muted" id={levelNote}>
          Heading levels stay after the content they set on every placement, so some properties can’t move past them.
        </p>
      )}
      {entries.length > 0 && <p className="insp-note muted">To add one, select a heading, text, image, button or icon and choose Fill in on each placement.</p>}
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
              quietCount
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

/**
 * A row's action buttons as one Tab stop: the arrow keys (and Home, End) move between them, unavailable ones included
 * so their reasons can be heard, and Tab goes on to the next row's name. The buttons keep their own names.
 */
function RowActions({ label, children }: { label: string; children: ReactNode }) {
  const [at, setAt] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.querySelectorAll('button').forEach((b, i) => (b.tabIndex = i === at ? 0 : -1));
  });
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
    const from = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (from < 0) return;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? from + 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? from - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    const next = (to + buttons.length) % buttons.length;
    setAt(next);
    buttons[next]?.focus();
  };
  return (
    <div ref={ref} className="contract-row-actions" role="toolbar" aria-label={label} onKeyDown={onKeyDown} onFocus={(e) => setAt(Math.max(0, [...(ref.current?.querySelectorAll('button') ?? [])].indexOf(e.target as Element as HTMLButtonElement)))}>
      {children}
    </div>
  );
}

/** A one-line add: a name and an "Add …" button that names what it adds; Enter adds too. */
function AddRow({ label, placeholder, button, onAdd }: { label: string; placeholder: string; button: string; onAdd: (text: string) => Promise<unknown> | null }) {
  const [text, setText] = useState('');
  const add = async () => {
    const sent = text;
    if (!sent.trim()) return;
    // Only the text sent is cleared: a name typed while it was being saved stays.
    if ((await onAdd(sent)) !== null) setText((t) => (t === sent ? '' : t));
  };
  return (
    <div className="contract-add">
      <input className="input sm" value={text} placeholder={placeholder} aria-label={label} maxLength={NAME_MAX} onChange={(e) => setText(e.target.value)} onKeyDown={keys({ enter: () => void add() })} />
      <button className="btn btn-sm" disabled={!text.trim()} onClick={() => void add()}>
        <Plus aria-hidden="true" /> {button}
      </button>
    </div>
  );
}

/**
 * The component's choices (Tone, Width) and the options of each (Light, Dark) that placements pick between: add,
 * rename, choose where placements start, remove, and pick an option to style.
 */
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
    const [sentGroup, sentFirst] = [group, first];
    if (!sentGroup.trim() || !sentFirst.trim()) return;
    if (await run((d, snap) => addVariantGroupOp(snap.state, d, sentGroup, sentFirst), `Add ${sentGroup.trim()} choice`)) {
      setGroup((t) => (t === sentGroup ? '' : t));
      setFirst((t) => (t === sentFirst ? '' : t));
    }
  };
  const removeChoice = async (axis: string, label: string) => {
    // Every option goes in one change, planned and counted from one reading of the project.
    const now = current(def.id);
    const a = now && axesOf(now.def).find(([x]) => x === axis)?.[1];
    if (!now || !a) return;
    // Every placement shows one of its options, chosen or the default: each loses it, styles and all.
    const showing = instancesOf(now.snap.state, def.id).filter((p) => selectedVariants(now.def, p.node.variants)[axis] !== undefined).length;
    if (showing) {
      const ok = await confirmDialog({
        title: `Remove “${label}”?`,
        body: `${showing === 1 ? 'One placement shows' : `${showing} placements show`} one of its options, and will lose it and its styles. Undo brings them back.`,
        confirmLabel: 'Remove',
        tone: 'caution'
      });
      if (!ok) return;
    }
    void apply(
      Object.keys(a.options).map((option) => removeVariantOp(now.def, axis, option)),
      `Remove ${label} choice`,
      now.snap
    );
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
    void apply([removeVariantOp(now.def, axis, option)], `Remove ${label} option`, now.snap);
  };
  return (
    <Section title="Variants" id="def-variants" level={level} keepMounted scope={axes.length ? tally(axes.length, 'choice', 'choices') : undefined}>
      {axes.length === 0 && <p className="insp-note muted">Choices each placement makes about how it looks, such as a Tone of Light or Dark. Style an option with its paintbrush, or under Style.</p>}
      {axes.map(([axis, a]) => (
        <div key={axis} className="contract-group" role="group" aria-label={`${a.label} choice`} data-axis={axis}>
          <div className="field">
            <label htmlFor={`${id}-${axis}`}>Choice</label>
            <div className="contract-row">
              <div className="contract-row-main">
                <DraftInput
                  id={`${id}-${axis}`}
                  value={a.label}
                  limit={CHOICE_MAX}
                  quietCount
                  onCommit={(v) => {
                    if (!v.trim()) return false;
                    void run((d) => renameVariantGroupOp(d, axis, v), `Rename ${a.label} choice`);
                  }}
                />
              </div>
              <button className="icon-btn sm" aria-label={`Remove ${a.label}`} title="Remove, with its options" onClick={() => void removeChoice(axis, a.label)}>
                <Trash2 />
              </button>
            </div>
          </div>
          <ul className="contract-list" aria-label={`${a.label} options`}>
            {Object.entries(a.options).map(([option, o]) => {
              const styling = target?.axis === axis && target.variant === option;
              const styled = !!o.styles && Object.keys(o.styles).length > 0;
              return (
                <li key={option} className="contract-row" data-variant={option}>
                  <div className="contract-row-main">
                    <DraftInput
                      className="input sm"
                      value={o.label}
                      limit={NAME_MAX}
                      quietCount
                      ariaLabel={`Name of the ${o.label} option`}
                      onCommit={(v) => {
                        if (!v.trim()) return false;
                        void run((d) => renameVariantOp(d, axis, option, v), `Rename ${o.label} option`);
                      }}
                    />
                    {styled && <span className="contract-meta">Has its own styles</span>}
                  </div>
                  <button className="icon-btn sm" aria-pressed={styling} aria-label={`Style ${o.label}`} title={styling ? 'Styling this option' : 'Style this option'} onClick={() => onStyle(styling ? null : { axis, variant: option })}>
                    <Paintbrush />
                  </button>
                  <button className="icon-btn sm" aria-label={`Remove ${o.label}`} title="Remove" onClick={() => void remove(axis, option, o.label)}>
                    <Trash2 />
                  </button>
                </li>
              );
            })}
          </ul>
          <AddRow label={`New ${a.label.toLowerCase()} option`} placeholder="New option" button="Add option" onAdd={(text) => run((d, snap) => addVariantOp(snap.state, d, axis, text), `Add ${text.trim()} option`)} />
          {Object.keys(a.options).length > 1 && (
            <Field label="Each placement starts on" controlId={`${id}-${axis}-default`}>
              <select
                id={`${id}-${axis}-default`}
                className="select sm"
                value={a.default}
                onChange={(e) => {
                  const option = e.target.value;
                  const label = a.options[option]?.label ?? option;
                  void run((d) => defaultVariantOp(d, axis, option), `Make ${label} the default`);
                }}
              >
                {Object.entries(a.options).map(([option, o]) => (
                  <option key={option} value={option}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      ))}
      <div className="contract-group" role="group" aria-labelledby={`${id}-new`}>
        <div className="field-label" id={`${id}-new`}>
          {axes.length ? 'Another choice' : 'New choice'}
        </div>
        <input className="input sm" value={group} placeholder="Choice, e.g. Tone" aria-label="Name of the choice" maxLength={CHOICE_MAX} onChange={(e) => setGroup(e.target.value)} onKeyDown={keys({ enter: () => void addGroup() })} />
        <div className="contract-add">
          <input className="input sm" value={first} placeholder="First option, e.g. Light" aria-label="Its first option" maxLength={NAME_MAX} onChange={(e) => setFirst(e.target.value)} onKeyDown={keys({ enter: () => void addGroup() })} />
          <button className="btn btn-sm" disabled={!group.trim() || !first.trim()} onClick={() => void addGroup()}>
            <Plus aria-hidden="true" /> Add choice
          </button>
        </div>
      </div>
    </Section>
  );
}

/** A design node as a selection of the component's own design, for where a new slot goes. */
const designRef = (def: ComponentDefinition, node: GraphNode | undefined) => (node ? { owner: { kind: 'component' as const, id: def.id }, instancePath: [], nodeId: node.id } : null);

/**
 * The places where each placement puts content of its own: declare one (with its placeholder inside the selected
 * container, or the whole design, in one Undo), change its name, what it takes and how many, and remove one no
 * placement fills. The engine refuses a contract that content placements already hold no longer fits, and says where;
 * the form keeps what the author chose until it saves. Removing one that holds content opens a review of where (#663),
 * which can remove it with that content.
 */
export function SlotsSection({ def, node, level }: { def: ComponentDefinition; node?: GraphNode; level: number }) {
  const state = useStore((s) => s.snapshot?.state);
  if (def.kind !== 'managed' || !def.tree || !state) return null;
  const names = Object.keys(def.slots ?? {});
  const placed = placedSlots(def);
  // Where each slot's content shows, named as the new slot's place is: by the element holding its placeholder.
  const placedIn = (name: string) => {
    const at = placed.get(name);
    if (!at) return undefined;
    const owner = { kind: 'component' as const, id: def.id };
    for (const n of Object.values(def.tree!.nodes)) {
      if ('children' in n && Array.isArray(n.children) && n.children.includes(at)) return slotPlaceWords(state, { owner, parentId: n.id } as InsertAt);
      // Passed on into a slot of a component placed in the design: "Section’s Content", as the add hint says it.
      const inner = n.kind === 'instance' ? Object.entries(n.slots ?? {}).find(([, ids]) => ids.includes(at))?.[0] : undefined;
      if (inner) return slotPlaceWords(state, { owner, parentId: n.id, slot: inner } as InsertAt);
    }
    return def.name;
  };
  // Shown on every element of the design, the slots are still the whole component's, not the selected element's.
  const inner = !!node && def.tree.rootIds[0] !== node.id;
  return (
    <Section title="Slots" id="def-slots" level={level} keepMounted scope={names.length ? `${tally(names.length, 'slot', 'slots')}${inner ? ' in the component' : ''}` : undefined}>
      {names.length === 0 && <p className="insp-note muted">Places where each placement puts content of its own, such as a card’s body or a hero’s buttons. Choose what each takes and how many.</p>}
      {names.map((name) => (
        <SlotGroup key={name} def={def} name={name} decl={def.slots![name]} placedIn={placedIn(name)} filledIn={slotFilledIn(state, def, name)} />
      ))}
      <NewSlot def={def} node={node} />
    </Section>
  );
}

function SlotGroup({ def, name, decl, placedIn, filledIn }: { def: ComponentDefinition; name: string; decl: SlotDef; placedIn?: string; filledIn: string[] }) {
  const [editing, setEditing] = useState(false);
  const pencil = useRef<HTMLButtonElement>(null);
  // Closing the form (Save, Cancel or Escape) puts focus back on the button that opened it.
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => pencil.current?.focus());
  };
  // A declaration damaged by a hand edit says so, and can still be removed; validation reports it too.
  const damaged = slotDeclProblem(decl);
  const places = [...new Set(filledIn)];
  // Named by the element holding it, so a slot listed under another selected element is not read as that element's.
  const shown = placedIn ? `In ${placedIn}` : 'Not in the design yet: add it from Insert';
  const filled = places.length ? `Holds content on ${places.join(', ')}` : 'Empty on every placement';
  const remove = () => {
    const now = current(def.id);
    if (!now || !declaredSlot(now.def, name)) return;
    // Content placements hold in it goes only once the author has seen where (#663): the review lists each placement,
    // with a way to it, and can remove the slot together with that content. It also says why a removal that would hide
    // content of another slot can't be made yet.
    const plan = planSlotRemoval(now.snap.state, def.id, name);
    if (plan && (plan.rows.length || plan.problem)) return void setState({ modal: { kind: 'removal-review', opening: now.snap.workspaceKey, definitionId: def.id, slot: name } });
    void apply([removeSlotOp(now.def, name)], `Remove ${typeof decl.label === 'string' && decl.label.trim() ? decl.label : name} slot`, now.snap);
  };
  if (damaged)
    return (
      <div className="contract-group" role="group" aria-label={name} data-slot={name}>
        <div className="field-error">
          The slot “{name}” {damaged}. Remove it, or undo the change that damaged it.
        </div>
        <button className="btn btn-sm" onClick={remove}>
          <Trash2 aria-hidden="true" /> Remove
        </button>
      </div>
    );
  return (
    <div className="contract-group" role="group" aria-label={decl.label} data-slot={name}>
      <div className="contract-row">
        <div className="contract-row-main">
          <strong className="slot-name">{decl.label}</strong>
          {decl.description && <span className="contract-meta">{decl.description}</span>}
          <span className="contract-meta" data-slot-accepts>
            Takes {slotAccepts(decl)} · {slotLimitWords(decl)}
          </span>
          <span className="contract-meta">
            {shown} · {filled}
          </span>
        </div>
        <button ref={pencil} className="icon-btn sm" aria-expanded={editing} aria-label={`Edit ${decl.label}`} title="Rename it, or change what it takes" onClick={() => setEditing((o) => !o)}>
          <Pencil />
        </button>
        <button className="icon-btn sm" aria-label={`Remove ${decl.label}`} title={places.length ? `${filled}. Review it before removing.` : 'Remove, with its place in the design'} onClick={remove}>
          <Trash2 />
        </button>
      </div>
      {editing && <SlotForm def={def} name={name} decl={decl} onDone={close} />}
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
  const form = useRef<HTMLDivElement>(null);
  const save = async () => {
    setTried(true);
    // Refused here: the author is taken to the field that says why, which may be far above Save.
    if (problem) {
      const field = form.current?.querySelector<HTMLInputElement>(draft.label.trim() ? `#${CSS.escape(`${id}-max`)}` : `#${CSS.escape(`${id}-name`)}`);
      field?.focus();
      field?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      return;
    }
    if (saving) return;
    const now = current(def.id);
    const d = now && declaredSlot(now.def, name);
    if (!now || !d) return void toast(`The “${base.label}” slot has been removed, so there is nothing to save. Undo brings it back.`, 'error');
    // Changed elsewhere since the form opened: what the author left alone follows it, and a part both changed is shown
    // to the author before anything is saved.
    const moved = rebaseSlotDraft(draft, base, d);
    setBase(d);
    setDraft(moved.draft);
    if (moved.clash) return void toast(`“${d.label}” changed while you were editing it. Check the form, then save again.`, 'info');
    const op = editSlotOp(now.def, name, moved.draft);
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
    <div ref={form} className="contract-box" role="group" aria-labelledby={`${id}-title`} data-slot-form={name}>
      <p className="insp-note" id={`${id}-title`}>
        <strong>Edit “{base.label}”</strong>
      </p>
      <Field label="Name" error={tried && problem && !draft.label.trim() ? problem : undefined}>
        <input id={`${id}-name`} className="input" value={draft.label} maxLength={SLOT_LABEL_MAX} onChange={(e) => set({ label: e.target.value })} onKeyDown={keys({ enter: () => void save(), escape: onDone })} autoFocus />
      </Field>
      <Field label="What belongs there" controlId={`${id}-desc`} hint="For you and the AI, when filling it in.">
        {/* Counted inside its box, as DraftInput counts (#1186), so the hint stays under it. */}
        <span className="field-counted box" style={{ '--count-ch': `${SLOT_DESCRIPTION_MAX} / ${SLOT_DESCRIPTION_MAX}`.length, '--field-rows': SLOT_DESCRIPTION_MAX >= 300 ? 4 : 3 } as CSSProperties}>
          <span className="field-frame">
            <textarea id={`${id}-desc`} className="textarea" rows={2} value={draft.description} maxLength={SLOT_DESCRIPTION_MAX} aria-describedby={`${id}-desc-count ${id}-desc-note`} onChange={(e) => set({ description: e.target.value })} />
            <div className="field-count" id={`${id}-desc-count`}>
              {draft.description.length} / {SLOT_DESCRIPTION_MAX}
            </div>
          </span>
        </span>
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
      <Field label="Holds at most" hint="Blank for no limit. 0 keeps it empty." error={tried && problem && draft.label.trim() ? problem : undefined}>
        <input id={`${id}-max`} className="input" inputMode="numeric" placeholder="No limit" value={draft.max} maxLength={4} onChange={(e) => set({ max: e.target.value })} onKeyDown={keys({ enter: () => void save(), escape: onDone })} />
      </Field>
      {tried && problem && (
        <p className="sr-only" role="alert">
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

/** Where a new slot's placeholder goes, in words: "Body", or "Section’s Content" when it is passed on to a component placed in the design. */
function slotPlaceWords(state: ProjectState, at: InsertAt): string {
  const holder = nodeLabel(state, at.owner, at.parentId!);
  if (!at.slot) return holder;
  const inst = state.components[at.owner.id]?.tree?.nodes[at.parentId!];
  const inner = inst?.kind === 'instance' ? state.components[inst.definitionId]?.slots?.[at.slot]?.label : undefined;
  return `${holder}’s ${inner ?? at.slot}`;
}

/** Declare a new slot, with its placeholder where slotInsertAt puts it for the node the Inspector shows. */
function NewSlot({ def, node }: { def: ComponentDefinition; node?: GraphNode }) {
  const id = useId();
  const [label, setLabel] = useState('');
  const state = useStore((s) => s.snapshot?.state);
  const at = state ? slotInsertAt(state, def.id, designRef(def, node)) : null;
  const where = state && at?.parentId ? slotPlaceWords(state, at) : null;
  const add = async () => {
    const now = current(def.id, node?.id);
    // Planned where the project has it now: the node may have gone, and the design's root then takes the slot.
    const place = now && slotInsertAt(now.snap.state, def.id, designRef(now.def, now.node));
    const plan = place && createSlotOps(now.snap.state, now.def, label, place);
    if (!now || !plan) return;
    const sent = label;
    if (await apply(plan.operations, `Add ${sent.trim()} slot`, now.snap)) setLabel((t) => (t === sent ? '' : t));
  };
  return (
    <div className="contract-group" role="group" aria-labelledby={`${id}-label`}>
      <div className="field-label" id={`${id}-label`}>
        {Object.keys(def.slots ?? {}).length ? 'Another slot' : 'New slot'}
      </div>
      <div className="contract-add">
        <input className="input sm" value={label} placeholder="Slot, e.g. Buttons" aria-label="Name of the new slot" aria-describedby={`${id}-where`} maxLength={SLOT_LABEL_MAX} disabled={!at} onChange={(e) => setLabel(e.target.value)} onKeyDown={keys({ enter: () => void add() })} />
        <button className="btn btn-sm" disabled={!at || !label.trim()} aria-describedby={at ? undefined : `${id}-where`} onClick={() => void add()}>
          <Plus aria-hidden="true" /> Add slot
        </button>
      </div>
      <p className="insp-note muted" id={`${id}-where`} data-slot-where>
        {where ? `It goes inside ${where}, and takes anything until you choose.` : SLOT_NO_PLACE}
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
  const hint = disabledReason ?? (target ? 'Only placements showing this option get these styles.' : undefined);
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
