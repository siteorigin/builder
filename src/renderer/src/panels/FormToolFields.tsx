import type { ComponentDefinition, InstanceNode, OwnerRef, ProjectState } from '@shared/types';
import { toolOverrides, webMcpOn, WEBMCP_DESCRIPTION_MAX, WEBMCP_TYPED_NAME_MAX } from '@shared/webmcp';
import { declaresFormTool, formToolBase, formToolDescription } from '@generator/webmcp';
import { forLabel, refTo } from '../lib/edit-label';
import { applyOps } from '../store';
import { DraftInput, Field } from '../components/ui';

/**
 * A contact form's WebMCP tool (shared/webmcp.ts): the name and description AI agents in a visitor's browser know it
 * by while the site declares its tools. Each field is its own edit, so typing one never undoes the other, and both keep
 * their words while WebMCP is off.
 */
export function FormToolFields({ state, owner, node, def }: { state: ProjectState; owner: OwnerRef; node: InstanceNode; def: ComponentDefinition }) {
  const own = toolOverrides(node);
  const here = refTo(owner, node.id);
  const set = (field: 'webmcpToolName' | 'webmcpToolDescription', value: string, label: string) =>
    void applyOps([{ type: 'node.setContent', owner, nodeId: node.id, field, value: value.trim() }], forLabel(state, value.trim() ? `Set ${label}` : `Clear ${label}`, here));
  const off = !webMcpOn(state.site);
  const unchanged = declaresFormTool(def);
  // What agents are told today, as the generator writes it (a form inside a design adds its own ID to the name).
  const name = formToolBase(node);
  const status = !unchanged
    ? 'This form’s code is not the theme’s form as Builder knows it (an edited copy, or one from the earliest versions), so it declares no tool.'
    : off
      ? 'Used once WebMCP is on (Site styles › AI agents).'
      : `Agents see “${name}”, numbered when a form in the page’s sections, header or footer has it already (search_site is the site search’s); a form inside a component or a content area adds its own ID instead.`;
  return (
    <>
      <Field label="Agent tool name" hint={`What AI agents in a visitor’s browser call this form (WebMCP). Letters, digits, “_”, “-”. ${status}`}>
        <DraftInput value={own.toolName} placeholder="contact" limit={WEBMCP_TYPED_NAME_MAX} onCommit={(v) => set('webmcpToolName', v, 'agent tool name')} />
      </Field>
      <Field label="Agent tool description" hint="What the form is for, as agents are told it. Empty: a description made from the form’s heading. The visitor always checks and sends the message.">
        <DraftInput multiline value={own.toolDescription} placeholder={formToolDescription(state, node)} limit={WEBMCP_DESCRIPTION_MAX} onCommit={(v) => set('webmcpToolDescription', v, 'agent tool description')} />
      </Field>
    </>
  );
}
