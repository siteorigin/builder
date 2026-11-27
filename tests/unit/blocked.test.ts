import { describe, expect, it } from 'vitest';
import { aiChanging, aiRunning, projectBlock, readOnlyBlock } from '../../src/renderer/src/lib/blocked';

const reason = 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.';

describe('blocked notes', () => {
  it('says a read-only project in the session’s own words, with nothing added', () => {
    expect(readOnlyBlock({ readOnly: { reason } })).toEqual({ kind: 'read-only', text: reason });
    expect(readOnlyBlock({ readOnly: null })).toBeNull();
  });

  it('puts read-only ahead of the AI, since waiting for the AI would not help', () => {
    expect(projectBlock({ readOnly: { reason }, aiBusy: true }, 'paste')).toEqual({ kind: 'read-only', text: reason });
  });

  it('says what waits for the AI, in one formula', () => {
    expect(projectBlock({ aiBusy: true }, 'paste')).toEqual({ kind: 'ai', text: 'The AI is making changes. You can paste once it finishes.' });
    expect(aiChanging('export')).toBe('The AI is making changes. You can export once it finishes.');
    expect(projectBlock({ aiBusy: false }, 'paste')).toBeNull();
    expect(projectBlock(null, 'paste')).toBeNull();
  });

  it('says when the AI is waiting on the author, since it never finishes on its own then', () => {
    expect(projectBlock({ aiBusy: true }, 'paste', 'awaiting-input')?.text).toBe('The AI is waiting for your answer in the AI panel. You can paste once you answer and it finishes.');
    expect(projectBlock({ aiBusy: true }, 'paste', 'running')?.text).toBe('The AI is making changes. You can paste once it finishes.');
    expect(aiRunning('running', 'build with AI')).toBe('The AI is working. You can build with AI once it finishes.');
    expect(aiRunning('awaiting-input', 'build with AI')).toBe('The AI is waiting for your answer in the AI panel. You can build with AI once you answer and it finishes.');
  });
});
