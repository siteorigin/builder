/**
 * Edit everywhere's controls for a component's contract: which content each placement fills in, which inner elements
 * each placement may style, and the looks placements choose between. Each control plans its change from the project
 * as it is when the author acts (lib/component-contract) and sends it against that revision, so a change planned on a
 * project that has moved on since is refused rather than misapplied. Every change is one Undo.
 */
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Paintbrush, Plus, Trash2 } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ComponentDefinition, GraphNode, PropSchema } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { isBinding } from '@shared/types';
import { axesOf, selectedVariants } from '@shared/variants';
import { instancesOf } from '@engine/tree';
import { applyOps, confirmDialog, getState, setState, useStore } from '../store';
import { DraftInput, Field, Section } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { designContent, type DesignContent } from '../lib/design-content';
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

/** Apply a change planned against `revision`, so one planned on a project that moved on is refused, not misapplied. */
const apply = (operations: EditOperation[], label: string, revision: number) => applyOps(operations, label, undefined, revision);

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
    if (await apply(plan.operations, `Fill in ${what.toLowerCase()} on each placement`, now.snap.revision)) setOpen(false);
  };
  const use = async (key: string) => {
    const now = current(def.id, node.id);
    if (!now?.node) return;
    // The property chosen, as the project has it now: one removed or retyped since the menu was drawn is not offered.
    const choice = bindChoices(now.snap.state, now.def, now.node, field).find((c) => choiceKey(c) === key);
    if (!choice) return;
    if (await apply([bindExistingOp(now.def, node.id, field, choice.binding)], `Show ${choice.label} in ${what.toLowerCase()}`, now.snap.revision)) setOpen(false);
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
      if (now && contentNow(now.def, now.node, field)?.source === 'default') void apply([unbindOp(now.def, node.id, field)], `Make ${what.toLowerCase()} the same in every placement`, now.snap.revision);
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

/** Under a tag each placement chooses: make it the design's own again, the one it shows now. */
export function TagBindingControl({ def, node, prop }: { def: ComponentDefinition; node: GraphNode; prop: string }) {
  const unbind = () => {
    const now = current(def.id, node.id);
    const tag = (now?.node as { tag?: unknown } | undefined)?.tag;
    if (now && isBinding(tag) && '$prop' in tag) void apply([{ type: 'node.setBinding', owner: { kind: 'component', id: def.id }, nodeId: node.id, field: 'tag', binding: null }], `Make ${nodeName(node).toLowerCase()} tag the same in every placement`, now.snap.revision);
  };
  return (
    <div className="contract-bind" data-contract="tag">
      <div className="contract-bind-line">
        <span className="faint">Each placement chooses “{def.properties[prop]?.label ?? prop}”.</span>
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
    if (op) void apply([op], `Move ${now.def.properties[prop].label} ${delta < 0 ? 'up' : 'down'}`, now.snap.revision);
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
    void apply([{ type: 'component.removePropSchema', definitionId: def.id, prop }], `Remove ${schema.label} property`, now.snap.revision);
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
                      if (op) void apply([op], `Rename ${schema.label} property`, now.snap.revision);
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
    if (now?.node && canExposePart(now.def, now.node)) void apply([exposePartOp(now.snap.state, now.def, now.node, nodeName(now.node))], `Let placements style ${nodeName(node)}`, now.snap.revision);
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
    void apply([{ type: 'component.removePart', definitionId: def.id, partId: part.id }], `Stop styling ${part.part.label} on placements`, now.snap.revision);
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
                if (op) void apply([op], `Rename ${found.part.label} part`, now.snap.revision);
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
 * The variant option Edit everywhere styles, still one the component has. One that is gone (an Undo, a removal) is
 * forgotten, so an option made again later under the same ID is not styled without being chosen.
 */
export function useVariantStyle(def: ComponentDefinition): StyleTarget {
  const stored = useStore((s) => (s.variantStyle?.definitionId === def.id ? s.variantStyle : null));
  const live = liveStyleTarget(def, stored ? { axis: stored.axis, variant: stored.variant } : null);
  const stale = !!stored && !live;
  useEffect(() => {
    if (stale && getState().variantStyle === stored) setState({ variantStyle: null });
  }, [stale, stored]);
  return live;
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
    return op ? apply([op], label, now.snap.revision) : null;
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
    void apply([removeVariantOp(now.def, axis, option)], `Remove ${label} variant`, now.snap.revision);
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
