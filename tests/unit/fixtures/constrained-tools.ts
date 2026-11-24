/**
 * The tool sets a grammar-constrained local model is offered in each kind of run, built from a real starter project
 * the way the orchestrator builds them.
 */
import type { ElementRef, InstanceNode } from '@shared/types';
import { createStarterState, type StarterId } from '@catalogue/starters';
import { toolsForRun } from '@agent/tools';
import { selectionTarget } from '@agent/selection';
import type { ToolDefinition } from '@agent/types';

export interface ToolSet {
  label: string;
  mode: string;
  tools: ToolDefinition[];
}

export function constrainedToolSets(starter: StarterId = 'business'): ToolSet[] {
  const state = createStarterState(starter, 'Test', false);
  const home = state.pages[state.site.homePageId];
  const section = home.nodes[home.rootIds[0]] as InstanceNode;
  const def = state.components[section.definitionId];
  const whole: ElementRef = { owner: { kind: 'page', id: home.id }, instancePath: [], nodeId: section.id };
  const partId = Object.keys(def.parts).find((p) => p !== 'root') ?? 'root';
  const part: ElementRef = { owner: { kind: 'page', id: home.id }, instancePath: [section.id], nodeId: def.parts[partId].nodeId, partId };
  const capabilities = { toolCalling: 'constrained-json' as const, contextWindowTokens: 32_000 };
  const sets: ToolSet[] = [];
  for (const codeEnabled of [false, true]) {
    const run = (label: string, opts: Partial<Parameters<typeof toolsForRun>[0]>) => {
      const r = toolsForRun({ state, selection: null, capabilities, codeEnabled, definitionOps: codeEnabled, ...opts });
      sets.push({ label: `${label}${codeEnabled ? ' (code)' : ''}`, mode: r.mode, tools: r.tools });
    };
    run('site', {});
    run('site component', { componentRequest: true });
    // A new component asked for from Create component (#172), with the tool that builds it whole (#359).
    run('component', { task: 'component' });
    run('selection', { selection: selectionTarget(whole) });
    run('part', { selection: selectionTarget(part) });
    run('ask', { ask: true });
    // A component's own design (#360): the whole of it, and a node selected in it.
    run('definition', { definition: true, definitionOps: true, definitionTarget: { definitionId: def.id } });
    run('definition node', { definition: true, definitionOps: true, definitionTarget: { definitionId: def.id, nodeId: def.parts[partId].nodeId } });
    // The general tools, as a design run has them once the author lets it change more.
    run('general', { definition: true, definitionOps: true });
  }
  return sets;
}
