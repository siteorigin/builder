/**
 * Edit everywhere's UI State & Interaction controls: the UI state a component's placements each hold (which tab
 * shows, whether a panel is open), what clicking one of its buttons does to it, and a container shown over the page
 * as a dialog or drawer while a yes/no state is on. Which elements show for which value is set under Conditions
 * (ConditionControls), and Component Studio's toolbar previews the component at any value, so a hidden tab or a
 * closed drawer can be selected and styled. Each change is planned from the project as it is when the author acts
 * (lib/ui-state) and sent against that revision, as the contract controls do, and is one Undo.
 */
import { useId, useState, type KeyboardEvent } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProjectSnapshot } from '@shared/api';
import type { ComponentDefinition, ElementNode, GraphNode, OverlayMode, UiStateSchema } from '@shared/types';
import { OVERLAY_MODES } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { declaredState } from '@engine/schema';
import { applyOps, getState } from '../store';
import { DraftInput, Field, Section, SwitchRow } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import {
  MAX_STATE_OPTIONS,
  OVERLAY_LABEL,
  actionWords,
  addOptionOp,
  addStateOp,
  clickActionOp,
  clickChoices,
  clickKey,
  initialStateOp,
  itemStateLists,
  itemStatePositions,
  newStateProblem,
  optionLabels,
  overlayOp,
  overlayOpensWhen,
  overlayRefusal,
  removeOptionOp,
  removeStateOp,
  renameOptionOp,
  renameStateOp,
  stateUseWords
} from '../lib/ui-state';

/** The longest labels the operations take: a state's, and one option's. */
const LABEL_MAX = 80;

/** The definition as the project holds it now, for a change planned when the author acts. */
function current(defId: string): { snap: ProjectSnapshot; def: ComponentDefinition } | null {
  const snap = getState().snapshot;
  const def = snap && Object.hasOwn(snap.state.components, defId) ? snap.state.components[defId] : undefined;
  return snap && def ? { snap, def } : null;
}

/**
 * Plan a change on the project as it is now and send it against that revision: refused if the project moves on
 * before it lands, never applied to another project opened meanwhile. Null when there is nothing to change.
 */
function run(defId: string, plan: (def: ComponentDefinition) => EditOperation | null, label: string | ((def: ComponentDefinition) => string)) {
  const now = current(defId);
  const op = now && plan(now.def);
  if (!now || !op) return null;
  const words = typeof label === 'string' ? label : label(now.def);
  return getState().snapshot?.workspaceKey === now.snap.workspaceKey ? applyOps([op], words, undefined, now.snap.revision) : Promise.resolve(null);
}

const KIND_WORDS: Record<UiStateSchema['type'], string> = { boolean: 'Yes or no', enum: 'Options', item: 'Active item' };

/** A section's summary: how many it holds, in plain words ("1 state"). */
const tally = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The component's UI state variables: add a yes/no state or one with options, rename it, its options and where every
 * placement starts, and remove what nothing uses any more (the engine names what still does).
 */
export function UiStateSection({ def, level }: { def: ComponentDefinition; level: number }) {
  const names = Object.keys(def.state ?? {});
  return (
    <Section title="UI state" id="def-state" level={level} keepMounted scope={names.length ? tally(names.length, 'state', 'states') : undefined}>
      {names.length === 0 && (
        <p className="insp-note muted">Values visitors change with the component’s buttons, such as which tab shows or whether a panel is open. Choose what a button does under When clicked.</p>
      )}
      {names.map((name) => (
        <StateGroup key={name} def={def} name={name} />
      ))}
      <NewState def={def} />
    </Section>
  );
}

function StateGroup({ def, name }: { def: ComponentDefinition; name: string }) {
  const id = useId();
  const s = declaredState(def, name);
  const uses = stateUseWords(def, name);
  if (!s) {
    return (
      <div className="contract-group" role="group" aria-label={name} data-state={name}>
        <div className="field-error">The UI state “{name}” is damaged. Remove it, or undo the change that damaged it.</div>
        <button className="btn btn-sm" onClick={() => void run(def.id, (d) => removeStateOp(d, name), `Remove ${name} state`)}>
          <Trash2 aria-hidden="true" /> Remove
        </button>
      </div>
    );
  }
  const title = s.label || name;
  const atMinimum = s.type === 'enum' && s.options.length <= 2;
  return (
    <div className="contract-group" role="group" aria-label={title} data-state={name}>
      <div className="field">
        <label htmlFor={`${id}-label`}>State</label>
        <div className="contract-row">
          <div className="contract-row-main">
            <DraftInput
              id={`${id}-label`}
              aria-describedby={`${id}-uses`}
              value={s.label}
              limit={LABEL_MAX}
              quietCount
              onCommit={(v) => {
                if (!v.trim()) return false;
                void run(def.id, (d) => renameStateOp(d, name, v), `Rename ${title} state`);
              }}
            />
            {uses.length > 2 ? (
              <details className="contract-uses">
                {/* Led by what it discloses, so it is not read as opening the options below. */}
                <summary className="contract-meta" id={`${id}-uses`}>
                  Used by {uses.length} elements · {KIND_WORDS[s.type]}
                </summary>
                <ul className="contract-meta">
                  {uses.map((u) => (
                    <li key={u}>{u}</li>
                  ))}
                </ul>
              </details>
            ) : (
              <span className="contract-meta" id={`${id}-uses`}>
                {KIND_WORDS[s.type]} · {uses.length ? `used by ${uses.join(', ')}` : 'not used yet'}
              </span>
            )}
            {uses.length > 0 && (
              <span className="contract-meta" id={`${id}-stays`}>
                Clear its uses to remove it.
              </span>
            )}
          </div>
          <button
            className="icon-btn sm"
            aria-label={`Remove ${title}`}
            aria-disabled={uses.length > 0 || undefined}
            aria-describedby={uses.length ? `${id}-uses ${id}-stays` : undefined}
            title={uses.length ? undefined : 'Remove'}
            onClick={() => !uses.length && void run(def.id, (d) => removeStateOp(d, name), `Remove ${title} state`)}
          >
            <Trash2 />
          </button>
        </div>
      </div>
      {s.type === 'item' ? (
        <Field
          label="Each placement starts on"
          hint={`This ${(def.properties[s.list] as { itemLabel?: string } | undefined)?.itemLabel?.toLowerCase() || 'item'} of ${def.properties[s.list]?.label || s.list} (the last one when a placement has fewer). Buttons in a repeat of the list make their item the active one; content there shows for it under Conditions.`}
        >
          <select className="select sm" value={String(s.initial)} onChange={(e) => void run(def.id, (d) => initialStateOp(d, name, Number(e.target.value)), `Start ${title} at item ${Number(e.target.value) + 1}`)}>
            {itemStatePositions(def, s).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      ) : s.type === 'boolean' ? (
        <Field label="Each placement starts">
          <select className="select sm" value={s.initial ? 'on' : 'off'} onChange={(e) => void run(def.id, (d) => initialStateOp(d, name, e.target.value === 'on'), `Start ${title} ${e.target.value}`)}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </Field>
      ) : (
        <>
          <ul className="contract-list" aria-label={`${title} options`}>
            {s.options.map((o) => (
              <li key={o.value} className="contract-row" data-option={o.value}>
                <div className="contract-row-main">
                  <DraftInput
                    className="input sm"
                    value={o.label}
                    limit={LABEL_MAX}
                    quietCount
                    ariaLabel={`Name of the ${o.label} option`}
                    onCommit={(v) => {
                      if (!v.trim()) return false;
                      void run(def.id, (d) => renameOptionOp(d, name, o.value, v), `Rename ${o.label} option`);
                    }}
                  />
                </div>
                <button
                  className="icon-btn sm"
                  aria-label={`Remove ${o.label}`}
                  title={atMinimum ? undefined : 'Remove'}
                  aria-disabled={atMinimum || undefined}
                  aria-describedby={atMinimum ? `${id}-minimum` : undefined}
                  onClick={() => !atMinimum && void run(def.id, (d) => removeOptionOp(d, name, o.value), `Remove ${o.label} option`)}
                >
                  <Trash2 />
                </button>
              </li>
            ))}
          </ul>
          {atMinimum && (
            <p className="insp-note muted" id={`${id}-minimum`}>
              A state with options keeps at least two.
            </p>
          )}
          <AddOption def={def} name={name} label={title} />
          <Field label="Each placement starts on" controlId={`${id}-start`}>
            <select id={`${id}-start`} className="select sm" value={s.initial} onChange={(e) => void run(def.id, (d) => initialStateOp(d, name, e.target.value), `Start ${title} at ${s.options.find((o) => o.value === e.target.value)?.label ?? e.target.value}`)}>
              {s.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}
    </div>
  );
}

/** Enter (not one that ends an input method's composition) adds. */
const onEnter = (add: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
  if (!isImeComposing(e) && e.key === 'Enter') add();
};

function AddOption({ def, name, label }: { def: ComponentDefinition; name: string; label: string }) {
  const id = useId();
  const [text, setText] = useState('');
  const s = declaredState(def, name);
  const full = s?.type === 'enum' && s.options.length >= MAX_STATE_OPTIONS;
  const add = async () => {
    const sent = text;
    if (!sent.trim() || full) return;
    // Only the text sent is cleared: one typed while it was being saved stays.
    if ((await run(def.id, (d) => addOptionOp(d, name, sent), `Add ${sent.trim()} option`)) !== null) setText((t) => (t === sent ? '' : t));
  };
  return (
    <>
      <div className="contract-add">
        <input
          className="input sm"
          value={text}
          placeholder="New option"
          aria-label={`New ${label.toLowerCase()} option`}
          aria-describedby={full ? `${id}-full` : undefined}
          maxLength={LABEL_MAX}
          disabled={full}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onEnter(() => void add())}
        />
        <button className="btn btn-sm" disabled={!text.trim() || full} onClick={() => void add()}>
          <Plus aria-hidden="true" /> Add option
        </button>
      </div>
      {full && (
        <p className="insp-note muted" id={`${id}-full`}>
          It has {MAX_STATE_OPTIONS} options, the most a state can have.
        </p>
      )}
    </>
  );
}

function NewState({ def }: { def: ComponentDefinition }) {
  const id = useId();
  const [label, setLabel] = useState('');
  const [type, setType] = useState<UiStateSchema['type']>('enum');
  const [options, setOptions] = useState('');
  const lists = itemStateLists(def);
  const [chosenList, setList] = useState('');
  const list = lists.some((l) => l.name === chosenList) ? chosenList : lists[0]?.name;
  const listed = optionLabels(options);
  const problem = newStateProblem(def, label, type, listed, list);
  // A problem is said once there is something to say it about: an untouched form only waits for its name. Once an add
  // is refused for it, it is an error on the field to fix, until that is fixed.
  const [tried, setTried] = useState(false);
  const shown = problem && (tried || label.trim() || options.trim()) ? problem : null;
  const refused = tried && !!problem;
  const badName = refused && !label.trim();
  const badOptions = refused && !badName && type === 'enum';
  const add = async () => {
    if (problem) return setTried(true);
    setTried(false);
    const [sentLabel, sentOptions] = [label, options];
    const done = await run(def.id, (d) => (newStateProblem(d, label, type, listed, list) ? null : addStateOp(d, label, type, listed, list)), `Add ${label.trim()} state`);
    // Only what was sent is cleared: text typed while it was being saved stays.
    if (done !== null) {
      setLabel((t) => (t === sentLabel ? '' : t));
      if (type === 'enum') setOptions((t) => (t === sentOptions ? '' : t));
    }
  };
  const any = Object.keys(def.state ?? {}).length > 0;
  const button = (
    <button className="btn btn-sm contract-add-end" disabled={!!problem} aria-describedby={shown ? `${id}-problem` : `${id}-start`} onClick={() => void add()}>
      <Plus aria-hidden="true" /> Add state
    </button>
  );
  return (
    <div className="contract-group" role="group" aria-labelledby={`${id}-title`}>
      <div className="field-label" id={`${id}-title`}>
        {any ? 'Another state' : 'New state'}
      </div>
      <div className="contract-add">
        <input className="input sm" value={label} placeholder={type === 'enum' ? 'Name, e.g. Billing' : 'Name, e.g. Menu open'} aria-label="Name of the state" aria-describedby={shown ? `${id}-problem` : undefined} aria-invalid={badName || undefined} maxLength={LABEL_MAX} onChange={(e) => setLabel(e.target.value)} onKeyDown={onEnter(() => void add())} />
        <select className="select sm contract-kind" aria-label="Kind of state" value={type} onChange={(e) => setType(e.target.value as UiStateSchema['type'])}>
          <option value="enum">Options</option>
          <option value="boolean">Yes or no</option>
          {(lists.length > 0 || type === 'item') && <option value="item">Active item of a list</option>}
        </select>
      </div>
      <div className="contract-add">
        {type === 'item' && (
          <select className="select sm" aria-label="The list whose active item it holds" value={list ?? ''} onChange={(e) => setList(e.target.value)}>
            {lists.map((l) => (
              <option key={l.name} value={l.name}>
                {l.label}
              </option>
            ))}
          </select>
        )}
        {type === 'enum' && <input className="input sm" value={options} placeholder="Options, e.g. Monthly, Annual" aria-label="Its options, separated by commas" aria-describedby={shown ? `${id}-problem` : undefined} aria-invalid={badOptions || undefined} onChange={(e) => setOptions(e.target.value)} onKeyDown={onEnter(() => void add())} />}
        {button}
      </div>
      {shown ? (
        <p className={refused ? 'field-error' : 'insp-note muted'} id={`${id}-problem`}>
          {shown}
        </p>
      ) : (
        <p className="insp-note muted" id={`${id}-start`}>
          {type === 'enum' ? 'Each placement starts on the first option.' : type === 'item' ? 'Each placement starts on the first item.' : 'Each placement starts off.'}
        </p>
      )}
    </div>
  );
}

/** What clicking a button of the design does to the component's UI state: nothing else, or one change to one state. */
export function ClickActionSection({ def, node, level }: { def: ComponentDefinition; node: GraphNode & { kind: 'link' }; level: number }) {
  const id = useId();
  const choices = clickChoices(def, node.id);
  const action = node.stateAction;
  const key = clickKey(action);
  const known = choices.some((c) => c.key === key);
  const stepping = !!action && (action.op === 'next' || action.op === 'prev');
  const name = node.name?.trim() || 'the button';
  // A plan made from what the section shows: refused (nothing sent) when the button's action changed since.
  const still = (d: ComponentDefinition) => {
    const live = d.tree?.nodes[node.id];
    return live?.kind === 'link' && clickKey(live.stateAction) === key ? live : null;
  };
  return (
    <Section title="When clicked" id="def-click" level={level} scope={action ? actionWords(def, action) : undefined}>
      {choices.length > 1 || action ? (
        <>
          <Field
            label="Also changes"
            controlId={id}
            hint="The button keeps its link. With no link it only does this, and every placement shows it."
            error={!known && action ? `This changes “${action.state}” in a way the component’s UI state no longer allows. Choose another, or clear it.` : undefined}
          >
            <select
              id={id}
              className="select"
              value={known ? key : `missing:${key}`}
              onChange={(e) => {
                const choice = choices.find((c) => c.key === e.target.value);
                if (choice) void run(def.id, (d) => clickActionOp(d, node, choice), choice.action ? `${choice.label} when ${name} is clicked` : `Clear what ${name} changes`);
              }}
            >
              {choices.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
              {!known && action && <option value={`missing:${key}`}>{actionWords(def, action)} (missing)</option>}
            </select>
          </Field>
          {stepping && known && (
            <SwitchRow
              checked={action.wrap === true}
              label="Go round at the end"
              hint="After the last option it goes back to the first (and before the first, to the last)."
              onChange={(v) => {
                const choice = choices.find((c) => c.key === key);
                if (choice) void run(def.id, (d) => (still(d) ? clickActionOp(d, still(d)!, choice, v) : null), v ? `Go round when ${name} is clicked` : `Stop at the end when ${name} is clicked`);
              }}
            />
          )}
        </>
      ) : (
        <p className="insp-note muted">Add UI state to the component (UI state, on the whole component) to make this button switch a tab or open a panel.</p>
      )}
    </Section>
  );
}

/** Whether to offer the Dialog or drawer control for a node: a container below the top, while the design has a yes/no state or it already is one. */
export function overlayOffered(def: ComponentDefinition, node: GraphNode): node is ElementNode {
  if (node.kind !== 'element') return false;
  // One set already (a hand edit's on the top element, say) can always be cleared.
  if (node.overlay !== undefined) return true;
  return !def.tree?.rootIds.includes(node.id) && Object.keys(def.state ?? {}).some((n) => declaredState(def, n)?.type === 'boolean');
}

/** Show a container over the page as a dialog or drawer while its yes/no state is on, or in its place. */
export function OverlaySection({ def, node, level }: { def: ComponentDefinition; node: ElementNode; level: number }) {
  const id = useId();
  const refusal = overlayRefusal(def, node);
  const mode = node.overlay;
  // A value a hand edit left that is no way of showing it: listed as it is, so choosing In its place clears it.
  const known = !mode || (OVERLAY_MODES as readonly string[]).includes(mode);
  const opens = overlayOpensWhen(def, node);
  return (
    <Section title="Dialog or drawer" id="def-overlay" level={level} defaultOpen={!!mode} scope={mode ? (known ? OVERLAY_LABEL[mode] : String(mode)) : undefined}>
      <Field
        label="Show it"
        controlId={id}
        error={mode && refusal ? `It shows in its place for now: this container ${refusal}` : undefined}
        hint={
          !mode && refusal
            ? `This container ${refusal}`
            : mode && !refusal && opens
            ? `Over the page while ${opens}: its buttons open and close it, and Escape closes it. Preview it open in Component Studio to edit what is inside.`
            : undefined
        }
      >
        <select
          id={id}
          className="select"
          value={mode ?? ''}
          onChange={(e) => {
            const next = (e.target.value || null) as OverlayMode | null;
            void run(def.id, (d) => overlayOp(d, node, next), next ? `Show ${node.name?.trim() || 'container'} as a ${next === 'dialog' ? 'dialog' : 'drawer'}` : `Show ${node.name?.trim() || 'container'} in its place`);
          }}
        >
          <option value="">In its place</option>
          {!known && <option value={String(mode)}>{String(mode)} (not a dialog or drawer)</option>}
          {OVERLAY_MODES.map((m) => (
            <option key={m} value={m} disabled={!!refusal && m !== mode}>
              {OVERLAY_LABEL[m]}
            </option>
          ))}
        </select>
      </Field>
    </Section>
  );
}
