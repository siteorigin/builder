import { describe, expect, it } from 'vitest';
import { pathHider } from '../driver/evidence';
import { auditTranscript, redactEvent } from '../coverage/transcript';

describe('the model-driven smoke test’s transcript (issue #498)', () => {
  const hide = pathHider([{ path: '/Users/ada/work/builder', label: '<repo>' }, { path: '/Users/ada', label: '~' }]);

  it('keeps no host path, user name, credential or image data', () => {
    const event = {
      type: 'item.completed',
      item: {
        type: 'mcp_tool_call',
        server: 'siteorigin_builder',
        tool: 'ui_snapshot',
        result: {
          content: [
            { type: 'text', text: 'Project folder /Users/ada/work/builder/out and key sk-live-ABCDEFGHIJKLMNOP' },
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUg==' }
          ],
          // The New project dialog draws its folder one segment at a time.
          structuredContent: { nodes: [{ text: 'Users/' }, { text: 'ada/' }, { text: 'workspace/' }] }
        }
      }
    };
    const kept = redactEvent(event, hide, 'ada');
    const text = JSON.stringify(kept);
    for (const leak of ['/Users/ada', 'ada/', 'sk-live', 'iVBORw0KGgo']) expect(text).not.toContain(leak);
    expect(kept.item.result.content[0].text).toBe('Project folder <repo>/out and key [redacted]');
    expect(kept.item.result.content[1]).toEqual({ type: 'image', mimeType: 'image/png', bytes: 18, data: '[image data left out]' });
    expect(kept.item.result.structuredContent.nodes.map((n) => n.text)).toEqual(['Users/', '<user>/', 'workspace/']);
    // A name that is part of another word is left alone.
    expect(redactEvent({ text: 'adaptive layouts by ada' }, hide, 'ada')).toEqual({ text: 'adaptive layouts by <user>' });
  });

  it('counts only the Builder server’s tools, and names every other tool the model used or tried', () => {
    const events = [
      { type: 'thread.started' },
      { type: 'item.completed', item: { type: 'reasoning', text: 'Looking.' } },
      { type: 'item.started', item: { type: 'mcp_tool_call', server: 'siteorigin_builder', tool: 'session_start' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'siteorigin_builder', tool: 'session_start', status: 'completed' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'siteorigin_builder', tool: 'ui_click', status: 'failed', error: { message: 'NOT_ACTIONABLE' } } },
      { type: 'item.started', item: { type: 'command_execution', command: 'cat tests/driver/session.ts' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'cat tests/driver/session.ts', status: 'failed' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'filesystem', tool: 'read_file' } },
      { type: 'item.completed', item: { type: 'web_search', query: 'siteorigin builder source' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } }
    ];
    const audit = auditTranscript(events, 'siteorigin_builder');
    expect(audit.calls).toEqual([
      { tool: 'session_start', ok: true },
      { tool: 'ui_click', ok: false }
    ]);
    expect(audit.foreign).toEqual(['command_execution: cat tests/driver/session.ts', 'mcp_tool_call filesystem read_file', 'web_search']);
  });
});
