/**
 * Which designs a code component renders by importing them, read from its source. Kept apart from ./definitions so the
 * checks that need it (where a contact form sends, ./form-destinations) import nothing that imports them.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { defFile } from '@generator/index';

/**
 * Whether a code component imports `defId`'s file (an import of it, not a comment or string that mentions it) or declares
 * it as a dependency: it then renders it, which `codeNeeds` in ./definitions (a looser reading, for what removal must not break) cannot say.
 */
export function codeImports(state: ProjectState, d: ComponentDefinition, defId: string): boolean {
  if (d.id === defId || d.kind !== 'code') return false;
  if ((d.dependencies ?? []).includes(defId)) return true;
  const target = Object.hasOwn(state.components, defId) ? state.components[defId] : undefined;
  if (!target || !d.source) return false;
  const file = defFile(target).split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*)['"][^'"\\n]*/${file}['"]`).test(d.source);
}
