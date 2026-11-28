/**
 * A component package is checked at export by importing it into a new project on the theme it was made on (#1417): a
 * style that names a font only that theme ships exports, where a project on another theme would refuse it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getVersion: () => '0.0.0', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  shell: { showItemInFolder: () => undefined },
  dialog: {},
  utilityProcess: { fork: () => ({ on() {}, postMessage() {}, kill: () => true }) }
}));

const { createStarterState } = await import('@catalogue/starters');
const { ProjectSession } = await import('../../src/main/project/session');
const { buildComponentPackage } = await import('../../src/main/project/component-package');
const { registerSecondTheme, SECOND_THEME_ID, SECOND_THEME_FONT } = await import('./second-theme');
await registerSecondTheme();

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const session = (themeId: string) => {
  const d = mkdtempSync(join(tmpdir(), 'so-pkg-theme-'));
  dirs.push(d);
  return ProjectSession.create(d, createStarterState('blank', 'Source', false, themeId));
};

describe('a package is checked on the theme it was made on (#1417)', () => {
  it('exports code using a style of a font only its theme ships', async () => {
    const s = await session(SECOND_THEME_ID);
    const made = await s.apply({ operations: [{ type: 'token.create', group: 'font', label: 'Quote face', value: `'${SECOND_THEME_FONT.family}', monospace` }] }, { label: 'Add' });
    expect(made.ok, made.error?.message).toBe(true);
    const token = made.results![0].tokenId as string;
    const code = await s.apply(
      { operations: [{ type: 'component.createCode', name: 'Quote', source: `<blockquote style="font-family: var(--so-${token.replace(/\./g, '-')})">Quote</blockquote>\n` }] },
      { label: 'Create', codeAllowed: true }
    );
    expect(code.ok, code.error?.message).toBe(true);
    const { pkg } = await buildComponentPackage(s.dir, s.state, code.results![0].definitionId as string);
    expect(pkg.tokens.map((t) => t.id)).toEqual([token]);
    await s.close();
  });
});
