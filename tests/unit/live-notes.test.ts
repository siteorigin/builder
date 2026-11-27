import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStarterState } from '@catalogue/starters';
import { checkRpcRequest } from '@shared/live/capabilities';
import { encodeFrame } from '@shared/live/messages';
import { isLiveNotes, MAX_NOTES, MAX_NOTES_BYTES, NOTE_TEXT_MAX, normalizeNoteText, NOTES_CHANGED, type LiveNote } from '@shared/live/notes';
import type { ProjectState } from '@shared/types';
import { makeNote, notePlace, NotesStore } from '../../src/main/project/notes';

/** Pinned notes (#770): the contract guests are held to, and how the host keeps them on disk. */

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'so-notes-'));
  dirs.push(d);
  return d;
}

const owner = async (fn: () => Promise<unknown>) => (await fn(), true);
const note = (id: string, extra: Partial<LiveNote> = {}): LiveNote => ({ id, text: `Note ${id}`, authorName: 'Ann', authorRole: 'viewer', createdAt: 1, pageId: 'p1', target: null, resolved: false, ...extra });

function project(): { state: ProjectState; home: string; about: string } {
  const state = createStarterState('blank', 'Acme', false);
  const home = state.site.homePageId;
  const about = 'p_about';
  state.pages[about] = { ...structuredClone(state.pages[home]), id: about, title: 'About', route: '/about-us/' };
  return { state, home, about };
}

describe('the notes contract', () => {
  it('keeps a note to 280 characters once spaces are run together, with nothing hidden in it', () => {
    expect(normalizeNoteText('  Swap   this\nphoto ')).toBe('Swap this photo');
    expect(normalizeNoteText('a'.repeat(NOTE_TEXT_MAX))).toBe('a'.repeat(NOTE_TEXT_MAX));
    expect(normalizeNoteText('a'.repeat(NOTE_TEXT_MAX + 1))).toBeNull();
    // Characters, not UTF-16 units: an emoji is one.
    expect(normalizeNoteText('😀'.repeat(NOTE_TEXT_MAX))).not.toBeNull();
    for (const bad of ['', '   ', 'a\u0000b', 'a‮b', '​']) expect(normalizeNoteText(bad), JSON.stringify(bad)).toBeNull();
  });

  it('takes a note’s text, and one of a page or an address, and nothing a guest may not choose', () => {
    expect(checkRpcRequest('viewer', 'notes.add', [{ text: 'Hi', previewPath: '/about-us/' }])).toEqual({ ok: true, value: { method: 'notes.add', args: [{ text: 'Hi', previewPath: '/about-us/' }] } });
    expect(checkRpcRequest('viewer', 'notes.list', [])).toEqual({ ok: true, value: { method: 'notes.list', args: [] } });
    expect(checkRpcRequest('collaborator', 'notes.resolve', ['n1', true])).toEqual({ ok: true, value: { method: 'notes.resolve', args: ['n1', true] } });
    expect(checkRpcRequest('collaborator', 'notes.delete', ['n1'])).toEqual({ ok: true, value: { method: 'notes.delete', args: ['n1'] } });
    for (const args of [[{ text: 'Hi' }], [{ text: 'Hi', pageId: 'p1', previewPath: '/' }], [{ text: 'Hi', pageId: 'p1', createdAt: 1 }], [{ text: 'Hi', pageId: 'p1', authorName: 'Host' }], [{ text: 'Hi', previewPath: '//evil.example/' }], [{ text: 'Hi', pageId: 'p1', target: { owner: { kind: 'page', id: 'p1' } } }]])
      expect(checkRpcRequest('viewer', 'notes.add', args), JSON.stringify(args)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('viewer', 'notes.list', ['x'])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'notes.resolve', ['n1'])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('collaborator', 'notes.delete', ['../x'])).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
    expect(checkRpcRequest('viewer', 'notes.delete', ['n1'])).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('carries the change of notes, and the notes themselves, in frames each side reads', () => {
    expect(encodeFrame('host-to-relay', { type: 'rpc:event', event: 'notes:changed', payload: NOTES_CHANGED }).ok).toBe(true);
    expect(encodeFrame('guest-to-relay', { type: 'rpc:request', requestId: 'r1', method: 'notes.add', args: [{ text: 'Hi', previewPath: '/' }] }).ok).toBe(true);
    expect(isLiveNotes({ notes: [note('n1')], guestNotes: true })).toBe(true);
    expect(isLiveNotes({ notes: [{ ...note('n1'), extra: 1 }], guestNotes: true })).toBe(false);
  });
});

describe('where a note is', () => {
  it('finds the page by its address, whatever its query or trailing slash', () => {
    const { state, home, about } = project();
    expect(notePlace(state, { text: 'x', previewPath: '/about-us/' })).toEqual({ pageId: about, target: null });
    expect(notePlace(state, { text: 'x', previewPath: '/about-us?ref=1' })).toEqual({ pageId: about, target: null });
    expect(notePlace(state, { text: 'x', previewPath: '/' })).toEqual({ pageId: home, target: null });
    expect(typeof notePlace(state, { text: 'x', previewPath: '/nowhere/' })).toBe('string');
    expect(typeof notePlace(state, { text: 'x', pageId: 'p_gone' })).toBe('string');
  });

  it('keeps an element only on the note’s page or in the shared header and footer', () => {
    const { state, home, about } = project();
    const onAbout = { owner: { kind: 'page' as const, id: about }, instancePath: [], nodeId: 'n1' };
    const header = { owner: { kind: 'shell' as const, id: 'header' }, instancePath: [], nodeId: 'n2' };
    expect(notePlace(state, { text: 'x', pageId: about, target: onAbout })).toEqual({ pageId: about, target: onAbout });
    expect(notePlace(state, { text: 'x', pageId: home, target: header })).toEqual({ pageId: home, target: header });
    expect(typeof notePlace(state, { text: 'x', pageId: home, target: onAbout })).toBe('string');
    expect(typeof notePlace(state, { text: 'x', pageId: home, target: { owner: { kind: 'component', id: 'c1' }, instancePath: [], nodeId: 'n' } })).toBe('string');
  });

  it('makes a note of normalized text, stamped by its keeper', () => {
    const made = makeNote({ text: '  Fix   the price ', pageId: 'p1' }, { pageId: 'p1', target: null }, { name: 'Ann', role: 'viewer' }, 42);
    expect(made).toMatchObject({ text: 'Fix the price', authorName: 'Ann', authorRole: 'viewer', createdAt: 42, pageId: 'p1', resolved: false });
    expect(makeNote({ text: 'x'.repeat(NOTE_TEXT_MAX + 1), pageId: 'p1' }, { pageId: 'p1', target: null }, { name: 'Ann', role: 'viewer' })).toMatch(/at most/);
    expect(makeNote({ text: '   ', pageId: 'p1' }, { pageId: 'p1', target: null }, { name: 'Ann', role: 'viewer' })).toMatch(/Write something/);
  });
});

describe('keeping notes', () => {
  it('keeps notes newest first, across a new store for the same file', async () => {
    const file = join(tempDir(), 'notes.json');
    const store = new NotesStore(file, owner);
    expect(await store.list()).toEqual([]);
    expect(existsSync(file)).toBe(false);
    await store.add(note('a'));
    await store.add(note('b'));
    expect(await store.resolve('a', true)).toMatchObject({ ok: true });
    const again = new NotesStore(file, owner);
    expect((await again.list()).map((n) => [n.id, n.resolved])).toEqual([
      ['b', false],
      ['a', true]
    ]);
    expect(await again.delete('b')).toMatchObject({ ok: true });
    expect(await again.delete('b')).toMatchObject({ ok: false, message: expect.stringMatching(/already been deleted/) });
    expect(await again.resolve('b', true)).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(file, 'utf8')).notes.map((n: LiveNote) => n.id)).toEqual(['a']);
  });

  it('makes changes one at a time, so none is lost to another made at once', async () => {
    const store = new NotesStore(join(tempDir(), 'notes.json'), owner);
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.add(note(`n${i}`))));
    await Promise.all([store.resolve('n3', true), store.delete('n4'), store.add(note('late'))]);
    const ids = (await new NotesStore(store.path, owner).list()).map((n) => n.id);
    expect(ids).toHaveLength(12);
    expect(ids).not.toContain('n4');
    expect(ids[0]).toBe('late');
  });

  it('refuses a note past the most a project keeps', async () => {
    const file = join(tempDir(), 'notes.json');
    writeFileSync(file, JSON.stringify({ notes: Array.from({ length: MAX_NOTES }, (_, i) => note(`n${i}`)) }));
    const store = new NotesStore(file, owner);
    expect(await store.add(note('more'))).toMatchObject({ ok: false });
    await store.delete('n0');
    expect(await store.add(note('more'))).toMatchObject({ ok: true });
  });

  it('writes nothing when access is taken away while the change waited, or the project is no longer this app’s', async () => {
    const file = join(tempDir(), 'notes.json');
    let allowed = true;
    const store = new NotesStore(file, owner);
    await store.add(note('a'));
    // Refused as its turn comes, and when it comes to be written.
    expect(await store.add(note('b'), () => (allowed ? null : 'Gone'))).toMatchObject({ ok: true });
    allowed = false;
    expect(await store.delete('a', () => (allowed ? null : 'You were removed.'))).toEqual({ ok: false, message: 'You were removed.' });
    let asked = 0;
    expect(await store.delete('a', () => (++asked > 1 ? 'Made a viewer.' : null))).toEqual({ ok: false, message: 'Made a viewer.' });
    const notOwner = new NotesStore(file, async () => false);
    expect(await notOwner.add(note('c'))).toMatchObject({ ok: false });
    expect(JSON.parse(readFileSync(file, 'utf8')).notes.map((n: LiveNote) => n.id)).toEqual(['b', 'a']);
  });

  it('never follows a link to another file’s notes, and never writes over a file it could not set aside', async () => {
    const file = join(tempDir(), 'notes.json');
    const theirs = join(tempDir(), 'notes.json');
    writeFileSync(theirs, JSON.stringify({ notes: [note('theirs')] }));
    symlinkSync(theirs, file);
    expect(await new NotesStore(file, owner).list()).toEqual([]);
    expect(readFileSync(theirs, 'utf8')).toContain('theirs');
    // Unreadable, and not this app's to move (another app holds the project, or it is read-only): left exactly as it is.
    const broken = join(tempDir(), 'notes.json');
    writeFileSync(broken, '{"notes": [ broken');
    const notOwner = new NotesStore(broken, async () => false);
    await expect(notOwner.list()).rejects.toThrow();
    expect(await notOwner.add(note('a'))).toMatchObject({ ok: false, unavailable: true });
    expect(readFileSync(broken, 'utf8')).toBe('{"notes": [ broken');
  });

  it('reads nothing through a local folder that is a link, and leaves a file it cannot read now where it is', async () => {
    const project = tempDir();
    const elsewhere = tempDir();
    writeFileSync(join(elsewhere, 'notes.json'), JSON.stringify({ notes: [note('theirs')] }));
    symlinkSync(elsewhere, join(project, '.siteorigin'));
    const linked = new NotesStore(join(project, '.siteorigin', 'notes.json'), owner);
    await expect(linked.list()).rejects.toThrow(/not a plain folder/);
    expect(await linked.add(note('mine'))).toMatchObject({ ok: false, unavailable: true });
    expect(JSON.parse(readFileSync(join(elsewhere, 'notes.json'), 'utf8')).notes.map((n: LiveNote) => n.id)).toEqual(['theirs']);
    // Not readable now (its permissions): an error, not a list to start again.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const dir = tempDir();
      const file = join(dir, 'notes.json');
      writeFileSync(file, JSON.stringify({ notes: [note('kept')] }));
      chmodSync(file, 0o000);
      try {
        await expect(new NotesStore(file, owner).list()).rejects.toThrow();
        expect(readdirSync(dir)).toEqual(['notes.json']);
      } finally {
        chmodSync(file, 0o600);
      }
    }
  });

  it('reads a notes file put back after it was missing, rather than writing over it', async () => {
    const file = join(tempDir(), 'notes.json');
    const store = new NotesStore(file, owner);
    expect(await store.list()).toEqual([]);
    // A sync puts the file back after the store found none.
    writeFileSync(file, JSON.stringify({ notes: [note('synced')] }));
    expect(await store.add(note('mine'))).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).notes.map((n: LiveNote) => n.id)).toEqual(['mine', 'synced']);
  });

  it('keeps a list at the cap readable after a resolved note is opened again', async () => {
    const file = join(tempDir(), 'notes.json');
    const deep = Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(128, 'x'));
    const target = { owner: { kind: 'page' as const, id: 'p1' }, instancePath: deep, nodeId: 'n', itemPath: deep };
    const bytes = (list: LiveNote[]) => Buffer.byteLength(JSON.stringify(list));
    // Resolved notes up to the cap, the last filled to it exactly.
    const notes: LiveNote[] = [];
    while (notes.length < MAX_NOTES - 1 && bytes([...notes, note(`n${notes.length}`, { target, resolved: true })]) <= MAX_NOTES_BYTES - 400) notes.push(note(`n${notes.length}`, { target, resolved: true }));
    // Then short notes, the last of them as long as it must be to reach the cap exactly.
    for (let i = 0; ; i++) {
      const fill = note(`f${i}`, { text: 'x', resolved: true });
      const room = MAX_NOTES_BYTES - bytes([...notes, fill]) + 1;
      fill.text = 'x'.repeat(Math.min(NOTE_TEXT_MAX, room));
      notes.push(fill);
      if (room <= NOTE_TEXT_MAX) break;
    }
    expect(bytes(notes)).toBe(MAX_NOTES_BYTES);
    writeFileSync(file, JSON.stringify({ notes }));
    const store = new NotesStore(file, owner);
    for (const n of notes) expect(await store.resolve(n.id, false)).toMatchObject({ ok: true });
    expect(bytes(JSON.parse(readFileSync(file, 'utf8')).notes)).toBeGreaterThan(MAX_NOTES_BYTES);
    expect(await new NotesStore(file, owner).list()).toHaveLength(notes.length);
  });

  it('sets aside a file holding more than a guest could be sent at once', async () => {
    const dir = tempDir();
    const file = join(dir, 'notes.json');
    const deep = Array.from({ length: 16 }, (_, i) => `${i}`.padEnd(128, 'x'));
    const target = { owner: { kind: 'page' as const, id: 'p1' }, instancePath: deep, nodeId: 'n', itemPath: deep };
    writeFileSync(file, JSON.stringify({ notes: Array.from({ length: MAX_NOTES }, (_, i) => note(`n${i}`, { text: 'é'.repeat(NOTE_TEXT_MAX), target })) }));
    expect(await new NotesStore(file, owner).list()).toEqual([]);
    expect(readdirSync(dir).some((n) => n.startsWith('notes-unreadable-'))).toBe(true);
  });

  it('reads the file again after a write that failed part way, so a note that reached the disk is never written over', async () => {
    const file = join(tempDir(), 'notes.json');
    let failAfter = false;
    const store = new NotesStore(file, async (fn) => {
      await fn();
      if (failAfter) throw new Error('The folder could not be flushed.');
      return true;
    });
    await store.add(note('a'));
    failAfter = true;
    expect(await store.add(note('b'))).toMatchObject({ ok: false, unavailable: true });
    failAfter = false;
    expect(await store.add(note('c'))).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).notes.map((n: LiveNote) => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('sets an unreadable file aside rather than writing over it', async () => {
    const dir = tempDir();
    const file = join(dir, 'notes.json');
    writeFileSync(file, '{"notes": [ broken');
    const store = new NotesStore(file, owner);
    expect(await store.list()).toEqual([]);
    const aside = readdirSync(dir).filter((n) => n.startsWith('notes-unreadable-'));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0]), 'utf8')).toBe('{"notes": [ broken');
    expect(await store.add(note('a'))).toMatchObject({ ok: true });
  });
});
