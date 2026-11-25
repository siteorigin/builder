import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createStarterState } from '@catalogue/starters';
import { applyOperations } from '@engine/apply';
import { generateProject } from '@generator/index';
it('probe', () => {
  const s = applyOperations(createStarterState('business', 'X', false), [{ type: 'theme.apply', themeId: 'editorial' }]).state;
  const css = generateProject(s).get('src/lib/siteorigin/styles/components.css')!;
  writeFileSync('.tmp/probe-390.txt', css);
});
