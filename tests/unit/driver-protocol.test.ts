// The test driver's wire contract (tests/driver/protocol.ts): what a request must look like, and the shape of every
// reply, so later clients can rely on it.
import { describe, expect, it } from 'vitest';
import { DriverError, ERROR_CODES, MAX_FRAME, MAX_TIMEOUT_MS, PROTOCOL_VERSION, errorInfo, failure, frameIdentity, parseRequest, success } from '../driver/protocol.ts';

const ctx = { sessionId: 's-1', window: { generation: 1, nativeId: 7 }, elapsedMs: 12, events: [] };

function refused(frame: unknown) {
  try {
    parseRequest(frame);
  } catch (e) {
    return errorInfo(e);
  }
  throw new Error('parseRequest accepted the frame');
}

describe('requests', () => {
  it('reads a full request, from text or an object, keeping only the known fields', () => {
    const r = parseRequest('{"v":1,"id":"a1","op":"window.info","args":{"x":1},"timeoutMs":500,"expectWindow":2,"extra":true}');
    expect(r).toEqual({ v: 1, id: 'a1', op: 'window.info', args: { x: 1 }, timeoutMs: 500, expectWindow: 2 });
    expect(parseRequest({ v: 1, id: 'b', op: 'session.describe' })).toEqual({ v: 1, id: 'b', op: 'session.describe' });
  });

  it('answers a frame that is not a request with BAD_REQUEST', () => {
    for (const frame of ['not json', '[]', 'null', { v: 1, op: 'session.describe' }, { v: 1, id: '', op: 'session.describe' }, { v: 1, id: 'x' }, { v: 1, id: 'x', op: 'describe' }, { v: 1, id: 'x', op: 'Session.Describe' }]) {
      expect(refused(frame).code, JSON.stringify(frame)).toBe('BAD_REQUEST');
    }
    expect(refused({ id: 'x', op: 'session.describe' }).code).toBe('BAD_REQUEST');
    expect(refused({ v: 1, id: 'x', op: 'window.info', args: [] }).code).toBe('BAD_REQUEST');
    expect(refused({ v: 1, id: 'x'.repeat(201), op: 'window.info' }).code).toBe('BAD_REQUEST');
  });

  it('bounds deadlines and window generations', () => {
    for (const timeoutMs of [0, -1, 1.5, '100', MAX_TIMEOUT_MS + 1]) expect(refused({ v: 1, id: 'x', op: 'window.info', timeoutMs }).code).toBe('BAD_REQUEST');
    expect(parseRequest({ v: 1, id: 'x', op: 'window.info', timeoutMs: MAX_TIMEOUT_MS }).timeoutMs).toBe(MAX_TIMEOUT_MS);
    for (const expectWindow of [0, 1.5, '2']) expect(refused({ v: 1, id: 'x', op: 'window.info', expectWindow }).code).toBe('BAD_REQUEST');
  });

  it('refuses a frame over the size limit before reading it', () => {
    const big = JSON.stringify({ v: 1, id: 'x', op: 'window.info', args: { pad: 'y'.repeat(MAX_FRAME) } });
    expect(refused(big)).toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining(String(MAX_FRAME)) });
  });

  it('names the versions it speaks when asked for another', () => {
    expect(refused({ v: 2, id: 'x', op: 'window.info' })).toEqual({ code: 'UNSUPPORTED_VERSION', message: expect.any(String), retryable: false, details: { supported: [PROTOCOL_VERSION] } });
  });

  it('keeps what correlates a broken frame with its sender', () => {
    expect(frameIdentity({ id: 'q', op: 'window.info', v: 9 })).toEqual({ id: 'q', op: 'window.info' });
    expect(frameIdentity({ id: 3, op: '' })).toEqual({ id: null, op: null });
    expect(frameIdentity('text')).toEqual({ id: null, op: null });
  });
});

describe('replies', () => {
  it('a success carries the version, id, op, session, window, timing, events and result', () => {
    expect(success({ id: 'a', op: 'window.info' }, { generation: 1 }, ctx)).toEqual({ v: 1, id: 'a', op: 'window.info', ok: true, sessionId: 's-1', window: { generation: 1, nativeId: 7 }, elapsedMs: 12, events: [], result: { generation: 1 } });
  });

  it('a failure carries a closed error code, whether a retry can help, and details', () => {
    const e = new DriverError('WINDOW_REPLACED', 'replaced', { details: { from: 1, to: 2 } });
    expect(failure({ id: 'a', op: 'window.info' }, e, ctx)).toEqual({
      v: 1,
      id: 'a',
      op: 'window.info',
      ok: false,
      sessionId: 's-1',
      window: { generation: 1, nativeId: 7 },
      elapsedMs: 12,
      events: [],
      error: { code: 'WINDOW_REPLACED', message: 'replaced', retryable: false, details: { from: 1, to: 2 } }
    });
    expect(failure({ id: null, op: null }, new Error('boom'), { ...ctx, window: null }).error).toEqual({ code: 'OP_FAILED', message: 'boom', retryable: false });
    expect(errorInfo(new DriverError('BUSY', 'later', { retryable: true }))).toEqual({ code: 'BUSY', message: 'later', retryable: true });
  });

  it('version 1 has a fixed set of error codes', () => {
    expect([...ERROR_CODES].sort()).toEqual(
      [
        'ALREADY_STARTED',
        'APP_EXITED',
        'BAD_REQUEST',
        'BUILD_MISSING',
        'BUSY',
        'CLEANUP_FAILED',
        'CLOSED',
        'LAUNCH_FAILED',
        'NOT_STARTED',
        'OP_FAILED',
        'TIMEOUT',
        'UNKNOWN_OP',
        'UNSUPPORTED_VERSION',
        'WINDOW_CLOSED',
        'WINDOW_REPLACED'
      ].sort()
    );
  });
});
