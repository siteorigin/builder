import { describe, expect, it } from 'vitest';
import { pathHider } from '../driver/evidence';
import { auditTranscript, redactEvent, redactText } from '../coverage/transcript';

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

  it('takes out every credential shape it knows and image data written inline, in any text it keeps', () => {
    const samples = {
      openai: 'sk-proj-ABCDEFGHIJKLMNOPQRST',
      anthropic: 'sk-ant-api03-ABCDEFGHIJKLMNOP',
      github: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWX12',
      githubPat: 'github_pat_11ABCDEFGHIJKLMNOPQRSTUV',
      slack: 'xoxb-1234567890-abcdefghij',
      aws: 'AKIAABCDEFGHIJKLMNOP',
      jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      bearer: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      lowerBearer: 'authorization: bearer abcdefghijklmnopqrstuvwxyz'
    };
    for (const [kind, secret] of Object.entries(samples)) expect(redactText(`the ${kind} key ${secret} here`, hide, 'ada'), kind).toMatch(/\[redacted\] here$/);
    expect(redactText('a picture data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== inline', hide, 'ada')).toBe('a picture [image data left out] inline');
    expect(redactText('ordinary words, Lantern Lane Kitchen, stay', hide, 'ada')).toBe('ordinary words, Lantern Lane Kitchen, stay');
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
      // Started and never finished (stopped, or cut off): still an attempt.
      { type: 'item.started', item: { type: 'file_change', changes: [{ path: 'src/main/index.ts' }] } },
      { type: 'item.completed', item: { type: 'todo_list', items: [{ text: 'Create the site', completed: true }] } },
      // Seen only as it went: still a tool used.
      { type: 'item.updated', item: { type: 'collab_tool_call', tool: 'spawn_agent' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
      { type: 'unparsed', text: '{"type":"item.comp' }
    ];
    const audit = auditTranscript(events, 'siteorigin_builder');
    expect(audit.calls).toEqual([
      { tool: 'session_start', ok: true },
      { tool: 'ui_click', ok: false }
    ]);
    expect(audit.foreign).toEqual(['command_execution: cat tests/driver/session.ts', 'mcp_tool_call filesystem read_file', 'web_search', 'file_change', 'collab_tool_call spawn_agent']);
    expect(audit.started).toBe(1);
    expect(audit.unreadable).toBe(1);
  });
});
