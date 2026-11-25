/** The Editorial pack: Foundation's component contracts with Editorial's tokens, type, rules and layouts. */
import type { AuthoredPack } from '../pack';
import { EDITORIAL } from './pack';
import { editorialComponents } from './components';

export function makeEditorialPack(foundation: AuthoredPack): AuthoredPack {
  return EDITORIAL.define(editorialComponents(EDITORIAL, foundation.components));
}
