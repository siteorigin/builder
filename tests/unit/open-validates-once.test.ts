/**
 * Opening a project checks its documents once (#959): the open refuses an inconsistent project on the same checks the
 * editor's first snapshot then shows, worked out once for the state it opened with.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectState } from '@shared/types';

// The whole check (the one diagnostics shows) is its core and its advice, each worked out for a state.
const checked: ProjectState[] = [];
const advised: ProjectState[] = [];
vi.mock('@engine/validate', async (load) => {
  const real = await load<typeof import('@engine/validate')>();
  return {
    ...real,
    coreValidation: (state: ProjectState, ...rest: unknown[]) => {
      checked.push(state);
      return real.coreValidation(state, ...(rest as []));
    },
    adviceValidation: (state: ProjectState, ...rest: unknown[]) => {
      advised.push(state);
      return real.adviceValidation(state, ...(rest as []));
    }
  };
});

const { createStarterState } = await import('@catalogue/starters');
const { ProjectSession } = await import('../../src/main/project/session');

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('opening a project (#959)', () => {
  it('checks its documents once for the open and the first snapshot', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'so-open-checks-')));
    dirs.push(dir);
    await (await ProjectSession.create(dir, createStarterState('business', 'Checks', false))).close();
    checked.length = 0;
    advised.length = 0;
    const s = await ProjectSession.open(dir, 'me');
    try {
      const shown = s.diagnostics();
      expect(s.diagnostics()).toBe(shown);
      expect(checked.filter((st) => st === s.state)).toHaveLength(1);
      expect(advised.filter((st) => st === s.state)).toHaveLength(1);
    } finally {
      await s.close();
    }
  });
});
