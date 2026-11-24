import { useEffect, useId, useRef } from 'react';
import type { ComponentDefinition, ConditionValue, GraphNode, OwnerRef } from '@shared/types';
import { applyOps } from '../store';
import { DraftInput, Section, SwitchRow } from '../components/ui';
import { bindingName, comparisonInput, conditionSources, readRule, ruleOp, sourceKey, startValue, type ConditionField, type ConditionRule, type ConditionSource, type ConditionTest } from '../lib/conditions';

const ROW_LABEL: Record<ConditionField, string> = { when: 'Show when…', unless: 'Hide when…' };
const NONE_LABEL: Record<ConditionField, string> = { when: 'Always shown', unless: 'Never hidden' };
const UNDO_LABEL: Record<ConditionField, string> = { when: 'show condition', unless: 'hide condition' };

/**
 * When a node of a component's design shows: "Show when…" and "Hide when…", each reading a property of the
 * component, a field of the item it is repeated for or the component's UI state, and, for a container, leaving it out when everything inside
 * it is hidden. Every placement follows these rules with its own values.
 */
export function ConditionControls({ def, node, level }: { def: ComponentDefinition; node: GraphNode; level?: number }) {
  const owner: OwnerRef = { kind: 'component', id: def.id };
  const sources = conditionSources(def, node.id);
  const rules = { when: readRule(def, node, 'when'), unless: readRule(def, node, 'unless') };
  const collapse = node.kind === 'element' && !!node.collapseEmpty;
  const count = (rules.when ? 1 : 0) + (rules.unless ? 1 : 0) + (collapse ? 1 : 0);
  return (
    <Section title="Conditions" id="def-conditions" level={level} scope={count ? (count === 1 ? '1 rule' : `${count} rules`) : undefined}>
      {(['when', 'unless'] as const).map((field) => (
        <ConditionRow key={field} def={def} node={node} owner={owner} field={field} rule={rules[field]} sources={sources} />
      ))}
      {node.kind === 'element' && (
        <SwitchRow
          checked={collapse}
          label="Hide container when all items inside are hidden"
          hint="Leaves the container out, spacing and background too, when the rules of the items inside hide them all. A repeat counts as shown while its list has items and its own rules show it."
          onChange={(v) => void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field: 'collapseEmpty', value: v }], v ? 'Hide empty container' : 'Always show container')}
        />
      )}
    </Section>
  );
}

function ConditionRow({
  def,
  node,
  owner,
  field,
  rule,
  sources
}: {
  def: ComponentDefinition;
  node: GraphNode;
  owner: OwnerRef;
  field: ConditionField;
  rule: ConditionRule | null;
  sources: ReturnType<typeof conditionSources>;
}) {
  const id = useId();
  const all = [...sources.props, ...sources.item, ...sources.state];
  const source = rule?.source;
  const input = source ? comparisonInput(source.schema) : null;
  // A value just typed is committed as its field loses focus, which choosing "is" or "is not" makes it do, before the
  // project has answered: that choice keeps the value typed, not the one shown a moment before. Once every save of
  // this row has been answered, the saved rule is current again: at once for one refused or held for later, and with
  // the next change to the rule (the answer itself, an undo) otherwise.
  const typed = useRef<{ key: string; value: ConditionValue } | null>(null);
  const inFlight = useRef(0);
  const saved = JSON.stringify(node[field] ?? null);
  useEffect(() => {
    if (!inFlight.current) typed.current = null;
  }, [saved]);
  const save = (next: { binding: ConditionRule['binding']; test: ConditionTest; value?: ConditionValue } | null) => {
    typed.current = next && next.value !== undefined ? { key: sourceKey(next.binding), value: next.value } : null;
    inFlight.current++;
    void applyOps([ruleOp(owner, node.id, field, next)], `${next ? 'Set' : 'Clear'} ${UNDO_LABEL[field]}`).then((r) => {
      inFlight.current--;
      if (!r) typed.current = null;
    });
  };
  const pickSource = (key: string) => {
    const s = all.find((x) => x.key === key);
    // A new source starts as a presence test: a value compared with one source rarely fits another.
    save(s ? { binding: s.binding, test: 'set' } : null);
  };
  const pickTest = (test: ConditionTest) => {
    if (!rule || !source) return;
    if (test === 'set') return save({ binding: rule.binding, test });
    // "Is" and "is not" swap keeping the value; a presence test starts from the property's default.
    const current = typed.current?.key === source.key ? typed.current.value : rule.value;
    save({ binding: rule.binding, test, value: rule.test !== 'set' ? current : startValue(source.schema) });
  };
  const missing = rule && !source;
  const name = rule ? bindingName(rule.binding) : '';
  return (
    <div className="field insp-condition" data-condition={field}>
      <label htmlFor={id}>{ROW_LABEL[field]}</label>
      <select id={id} className="select" value={rule ? sourceKey(rule.binding) : ''} onChange={(e) => pickSource(e.target.value)}>
        <option value="">{NONE_LABEL[field]}</option>
        {sources.props.length > 0 && (
          <optgroup label="Component properties">
            {sources.props.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </optgroup>
        )}
        {sources.item.length > 0 && (
          <optgroup label={`Each ${(sources.itemLabel ?? 'item').toLowerCase()}`}>
            {sources.item.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </optgroup>
        )}
        {sources.state.length > 0 && (
          <optgroup label="UI state">
            {sources.state.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </optgroup>
        )}
        {missing && <option value={sourceKey(rule.binding)}>{name} (missing)</option>}
      </select>
      {missing && <div className="field-error">This reads “{name}”, which the component no longer has here. Choose another, or clear it.</div>}
      {rule && source && (
        <div className="insp-condition-test">
          <select className="select" aria-label={`${ROW_LABEL[field].replace('…', '')} test`} value={rule.test} onChange={(e) => pickTest(e.target.value as ConditionTest)}>
            <option value="set">has a value</option>
            {input && <option value="eq">is</option>}
            {input && <option value="ne">is not</option>}
          </select>
          {rule.test !== 'set' && input && (
            <ConditionValueInput
              key={`${def.id}:${node.id}:${field}:${source.key}:${rule.test}`}
              source={source}
              value={rule.value}
              label={`${ROW_LABEL[field].replace('…', '')} value`}
              onChange={(value) => save({ binding: rule.binding, test: rule.test, value })}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** The value a comparison reads: on or off, one of a choice's options, a number, or text. */
function ConditionValueInput({ source, value, label, onChange }: { source: ConditionSource; value: ConditionValue | undefined; label: string; onChange: (v: ConditionValue) => void }) {
  const input = comparisonInput(source.schema);
  if (!input) return null;
  switch (input.kind) {
    case 'boolean':
      return (
        <select className="select" aria-label={label} value={value === false ? 'off' : 'on'} onChange={(e) => onChange(e.target.value === 'on')}>
          <option value="on">on</option>
          <option value="off">off</option>
        </select>
      );
    case 'choice':
      return (
        <select className="select" aria-label={label} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value)}>
          {typeof value === 'string' && !input.options.some((o) => o.value === value) && <option value={value}>{value}</option>}
          {input.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <DraftInput
          type="number"
          ariaLabel={label}
          value={typeof value === 'number' ? String(value) : ''}
          onCommit={(v) => {
            // A blank field is no number: refused, rather than read as zero.
            const n = v.trim() === '' ? NaN : Number(v);
            if (!Number.isFinite(n)) return false;
            onChange(n);
          }}
        />
      );
    case 'text': {
      // Text with several lines (an answer, a description) is compared whole, line breaks and all.
      const multiline = source.schema.type === 'string' && !!source.schema.multiline;
      return <DraftInput ariaLabel={label} multiline={multiline} rows={multiline ? 2 : undefined} value={typeof value === 'string' ? value : ''} placeholder="Text to compare with" onCommit={(v) => onChange(v)} />;
    }
  }
}
