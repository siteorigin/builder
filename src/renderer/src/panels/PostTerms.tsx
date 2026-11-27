import './PostTerms.css';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronRight, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Collection, EntryDoc } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { assignedTermIds, entriesWithTerm, hasArchivePages, termIdFor } from '@shared/collections';
import { archiveRoute, defaultArchiveDescription } from '@shared/archives';
import { TEXT_LIMITS } from '@shared/text-limits';
import { termFeedUses } from '@engine/terms';
import { commitOps, confirmDialog, getState, toast, undoAction, useStore } from '../store';
import { DraftInput, Modal, Tabs } from '../components/ui';
import { isImeComposing } from '../lib/ime';
import { trackApply } from '../lib/pending';
import { postAt, type PostRef } from '../lib/posts';
import { entryNounLower } from '../lib/content';

/**
 * The groupings a post is filed under: those its collection declares (the blog starts with categories and tags). One
 * removed in the collection's settings is gone from here too (#675), so filing a post never brings it back.
 */
export function postTaxonomies(collection: Collection): Array<{ id: string; label: string }> {
  const own = collection.settings.taxonomies && typeof collection.settings.taxonomies === 'object' ? collection.settings.taxonomies : {};
  return Object.entries(own).map(([id, t]) => ({ id, label: typeof t?.label === 'string' ? t.label : id }));
}

/** What the terms manager is called: "Categories and tags" for articles, the groupings' own names for records. */
export function termsManagerTitle(collection: Collection): string {
  const groupings = postTaxonomies(collection);
  const named = groupings.map((g) => g.label);
  if (groupings.length === 2 && groupings[0].id === 'categories' && groupings[1].id === 'tags') return 'Categories and tags';
  return named.length === 1 ? named[0] : named.length ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)!.toLowerCase()}` : 'Groupings';
}

/** "category", "tag", or "term" for any other grouping. */
export const termNoun = (taxonomyId: string) => (taxonomyId === 'categories' ? 'category' : taxonomyId === 'tags' ? 'tag' : 'term');

/** A grouping's terms in the order they are offered. */
export function termsOf(collection: Collection | undefined, taxonomyId: string): Array<{ id: string; label: string }> {
  const t = collection?.settings.taxonomies && Object.hasOwn(collection.settings.taxonomies, taxonomyId) ? collection.settings.taxonomies[taxonomyId] : undefined;
  const terms = t?.terms && typeof t.terms === 'object' ? t.terms : {};
  return Object.entries(terms).map(([id, x]) => ({ id, label: typeof x?.label === 'string' ? x.label : id }));
}

/** The term of a grouping with this name, ignoring case. */
const termCalled = (collection: Collection | undefined, taxonomyId: string, label: string) => termsOf(collection, taxonomyId).find((t) => t.label.trim().toLowerCase() === label.trim().toLowerCase());

const posts = (n: number) => (n === 1 ? '1 post' : `${n} posts`);

/** The answer to a change sent at a revision: applied (with the revision it made), the project moved on, or refused. */
type Sent = { ok: boolean; revision: number; error?: { code: string } } | null;

/**
 * The categories and tags of the post open in the writer: each term a checkbox, and a name typed below adds a term
 * and files the post under it in one step. Each change is worked out from the project as it is when its turn comes,
 * after the one before it has landed, and sent checked against that revision, so it never writes over another change
 * to the post; Publish and Save draft wait for every change asked for, from the moment it is asked.
 */
export function PostTermFields({
  post,
  collection,
  entry,
  sendAt,
  track,
  refused
}: {
  post: PostRef;
  collection: Collection;
  entry: EntryDoc;
  sendAt: (ops: EditOperation[], label: string, revision: number) => Promise<Sent>;
  track: <T>(p: Promise<T>) => Promise<T>;
  refused: () => void;
}) {
  const revision = useStore((s) => s.snapshot?.revision ?? 0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * What this writer last filed the post under in each grouping, and the revision that change made: the next change
   * is worked out from it while the project's copy with it is still on its way.
   */
  const sent = useRef<Record<string, { ids: string[]; revision: number }>>({});
  /**
   * Send the change `make` works out from the post's terms of a grouping as the project has them, again if the project
   * moved on meanwhile. Undefined when there was nothing to change; null when it was refused.
   */
  const change = (taxonomyId: string, make: (c: Collection, ids: string[]) => { ops: EditOperation[]; label: string } | null): Promise<Sent | undefined> => {
    const attempt = async (): Promise<Sent | undefined> => {
      for (let tries = 0; tries < 4; tries++) {
        const now = getState().snapshot;
        const c = now?.state.collections[post.collectionId];
        const e = now ? postAt(now.state, post) : undefined;
        if (!now || !c || !e) return null;
        const stored: unknown = e.terms && Object.hasOwn(e.terms, taxonomyId) ? e.terms[taxonomyId] : [];
        // The project's copy without this writer's last change yet: worked out from that change, at the revision it made.
        const mine = sent.current[taxonomyId];
        const behind = !!mine && now.revision < mine.revision;
        const ids = behind ? mine.ids : Array.isArray(stored) ? (stored as string[]) : [];
        const planned = make(c, ids);
        if (!planned) return undefined;
        const r = await sendAt(planned.ops, planned.label, behind ? mine.revision : now.revision);
        if (r?.ok) {
          const update = planned.ops.find((o) => o.type === 'entry.update');
          const next = update?.type === 'entry.update' ? update.terms?.[taxonomyId] : undefined;
          if (next) sent.current[taxonomyId] = { ids: next, revision: r.revision };
        }
        if (!r || r.ok) return r;
        // The project moved on (its copy may still be on its way here): worked out again from it.
        await new Promise((done) => setTimeout(done, 50 * (tries + 1)));
      }
      // Said beside the picker, with a way to try again (TermChecks), rather than in a toast that goes.
      refused();
      return null;
    };
    const run = async (): Promise<Sent | undefined> => {
      try {
        return await attempt();
      } catch {
        refused();
        return null;
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p.catch(() => undefined);
    // Followed from the moment it is asked for: Publish, Save draft and closing the project wait for it, and closing
    // hears when it was not saved.
    trackApply(p.then((r) => (r === null ? { ok: false, message: 'A category or tag change was not saved.' } : { ok: true }), () => ({ ok: false, message: 'A category or tag change was not saved.' })));
    return track(p.catch(() => null));
  };
  const toggle = (taxonomyId: string, termId: string, on: boolean, label: string) =>
    change(taxonomyId, (_c, ids) =>
      ids.includes(termId) === on
        ? null
        : { ops: [{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, terms: { [taxonomyId]: on ? [...ids, termId] : ids.filter((id) => id !== termId) } }], label: `${on ? `File ${entryNounLower(collection)} under` : `Take ${entryNounLower(collection)} out of`} “${label}”` }
    );
  const add = (taxonomyId: string, label: string) =>
    change(taxonomyId, (c, ids) => {
      const existing = termCalled(c, taxonomyId, label);
      if (existing) return ids.includes(existing.id) ? null : { ops: [{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, terms: { [taxonomyId]: [...ids, existing.id] } }], label: `File ${entryNounLower(collection)} under “${existing.label}”` };
      // The new term's ID is chosen here, as the engine would choose it, so the post is filed under it in the same step.
      const terms = (c.settings.taxonomies && Object.hasOwn(c.settings.taxonomies, taxonomyId) ? c.settings.taxonomies[taxonomyId].terms : undefined) ?? {};
      const termId = termIdFor(terms, label, undefined, assignedTermIds(c, taxonomyId));
      return {
        ops: [
          { type: 'collection.createTerm', collectionId: post.collectionId, taxonomyId, label, termId },
          { type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, terms: { [taxonomyId]: [...ids, termId] } }
        ],
        label: `Add ${termNoun(taxonomyId)} “${label}”`
      };
    });
  return (
    <>
      {postTaxonomies(collection).map((t) => (
        <TermChecks
          key={t.id}
          taxonomy={t}
          terms={termsOf(collection, t.id)}
          chosen={Array.isArray(entry.terms?.[t.id]) ? entry.terms[t.id] : []}
          revision={revision}
          entry={entryNounLower(collection)}
          onToggle={(id, on, label) => toggle(t.id, id, on, label)}
          onAdd={(label) => add(t.id, label)}
        />
      ))}
    </>
  );
}

/** Past this many terms a grouping's list is filtered by what is typed and scrolls, its chosen terms shown above it. */
const MANY_TERMS = 12;

function TermChecks({
  taxonomy,
  terms,
  chosen,
  revision,
  entry,
  onToggle,
  onAdd
}: {
  taxonomy: { id: string; label: string };
  terms: Array<{ id: string; label: string }>;
  chosen: string[];
  revision: number;
  /** What one entry is called ("post", "case study"). */
  entry: string;
  onToggle: (termId: string, on: boolean, label: string) => Promise<Sent | undefined>;
  onAdd: (label: string) => Promise<Sent | undefined>;
}) {
  const uid = useId();
  const [name, setName] = useState('');
  const group = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  /**
   * Ticks on their way, shown until the project has them: the latest click on each box (`seq`), and once it has landed
   * the revision it made, from which the project's own copy decides again.
   */
  const [pending, setPending] = useState<Record<string, { on: boolean; seq: number; landedAt?: number }>>({});
  const clicks = useRef(0);
  /**
   * Changes the project refused, each kept beside what it is about with a way to try it again, until it lands or is left:
   * a box's by its term, an add's by the name typed.
   */
  const [failures, setFailures] = useState<Failure[]>([]);
  const fail = (f: Failure) => setFailures((all) => [...all.filter((x) => failureKey(x) !== failureKey(f)), f]);
  const settle = (key: string) => setFailures((all) => (all.some((x) => failureKey(x) === key) ? all.filter((x) => failureKey(x) !== key) : all));
  const chosenKey = chosen.join('\n');
  useEffect(() => {
    setPending((p) => {
      const kept = Object.entries(p).filter(([id, x]) => x.landedAt === undefined || (revision < x.landedAt && x.on !== chosen.includes(id)));
      return kept.length === Object.keys(p).length ? p : Object.fromEntries(kept);
    });
  }, [chosenKey, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Tick or untick a box; true once the project has it. */
  const toggle = (id: string, on: boolean, label: string): Promise<boolean> => {
    const seq = ++clicks.current;
    setPending((p) => ({ ...p, [id]: { on, seq } }));
    return onToggle(id, on, label).then((r) => {
      const ok = !(r === null || (r && !r.ok));
      setPending((p) => {
        if (p[id]?.seq !== seq) return p;
        // Refused: the project's own state shows again. Landed: shown until the project's copy has caught up with it.
        if (r === null || (r && !r.ok)) {
          fail({ kind: 'toggle', id, on, label });
          const { [id]: _gone, ...rest } = p;
          return rest;
        }
        settle(`toggle:${id}`);
        // Filed under it here: a refused try to file it under the same term by its name is answered too.
        if (on) settle(`add:${label.toLowerCase()}`);
        // The project's copy may already be here, with this change or a later one: it decides from now.
        const landedAt = r?.revision ?? 0;
        if ((getState().snapshot?.revision ?? 0) >= landedAt) {
          const { [id]: _done, ...rest } = p;
          return rest;
        }
        return { ...p, [id]: { on, seq, landedAt } };
      });
      return ok;
    });
  };
  const ticked = (id: string) => (Object.hasOwn(pending, id) ? pending[id].on : chosen.includes(id));
  const noun = termNoun(taxonomy.id);
  const plural = taxonomy.label.toLowerCase();
  const many = terms.length > MANY_TERMS;
  const typed = name.trim();
  const needle = typed.toLowerCase();
  const refusedBox = (id: string) => failures.some((f) => f.kind === 'toggle' && f.id === id);
  // With many terms what is typed finds them too; with few, every one is in view anyway.
  const matches = many && needle ? terms.filter((t) => t.label.toLowerCase().includes(needle)) : terms;
  const noMatch = many && !!needle && !matches.length;
  // A term whose change was refused stays in the list whatever is typed, marked, until it lands or is left.
  const shown = many && needle ? terms.filter((t) => matches.includes(t) || refusedBox(t.id)) : terms;
  const same = typed ? terms.find((t) => t.label.trim().toLowerCase() === needle) : undefined;
  // Typing a term's exact name and adding it files the entry under that term; one it is already under adds nothing.
  const canAdd = !!typed && !(same && ticked(same.id));
  const choose = !!same && !ticked(same.id);
  /** The name the last add filed the entry under: said while the entry is still under it and nothing else is typed. */
  const [added, setAdded] = useState<{ label: string; created: boolean } | null>(null);
  /**
   * Add the term typed, or again the one whose adding was refused (`retry`), whatever is typed now. A name that is
   * already a term chooses that term by its ID, as its box would, so choosing it never makes a new one.
   */
  const submit = async (retry?: { label: string; termId?: string }): Promise<boolean> => {
    if (!retry && !canAdd) return false;
    const label = retry?.label ?? typed;
    const existing = retry ? (retry.termId ? terms.find((t) => t.id === retry.termId) : undefined) : same;
    // A term chosen by name and gone since: still refused, for a fresh choice.
    if (retry?.termId && !existing) return false;
    const created = !existing;
    // From the field or its button, which a save can take the caret from (the button goes unavailable, the field moves).
    const hadFocus = !!group.current?.querySelector('.post-terms-add')?.contains(document.activeElement);
    const r = existing ? await onToggle(existing.id, true, existing.label) : await onAdd(label);
    // Kept when refused, to try again, and said beside the field; anything typed meanwhile is never cleared.
    if (r === null || (r && !r.ok)) return (fail({ kind: 'add', label, termId: existing?.id }), false);
    settle(`add:${label.toLowerCase()}`);
    // Filed under an existing term this way: a refused tick of its box is answered too.
    if (existing) settle(`toggle:${existing.id}`);
    setName((n) => (n.trim() === label ? '' : n));
    setAdded({ label: existing?.label ?? label, created });
    // The 13th term moves the field above the list, a new field: the caret goes with it, unless it has moved on.
    if (hadFocus) requestAnimationFrame(() => (!document.activeElement || document.activeElement === document.body || group.current?.querySelector('.post-terms-add')?.contains(document.activeElement)) && field.current?.focus());
    return true;
  };
  const picked = terms.filter((t) => ticked(t.id));
  // Each character spelled out, so two names never share an ID.
  const failedId = (f: Failure) => `${uid}-failed-${Array.from(failureKey(f), (c) => c.codePointAt(0)!.toString(36)).join('_')}`;
  /** Refusals being tried again: their line stays, its Try again unavailable, until the project answers. */
  const [retrying, setRetrying] = useState<string[]>([]);
  /** Said once more when a change tried again is refused again (its line already says what), cleared on the next change. */
  const [again, setAgain] = useState('');
  const retry = async (f: Failure, from: HTMLElement) => {
    const key = failureKey(f);
    if (retrying.includes(key)) return;
    setAgain('');
    setRetrying((r) => [...r, key]);
    const ok = await (f.kind === 'add' ? submit({ label: f.label, termId: f.termId }) : toggle(f.id, f.on, f.label));
    setRetrying((r) => r.filter((k) => k !== key));
    if (!ok) return setAgain(`Still not saved: “${f.label}”.`);
    // Landed, its line goes with the caret on it: once it has gone, back to what it was about.
    requestAnimationFrame(() => !from.isConnected && (!document.activeElement || document.activeElement === document.body) && backTo(f));
  };
  const refusalOf = (id: string) => failures.find((f) => f.kind === 'toggle' && f.id === id);
  const box = (t: { id: string; label: string }) => {
    const refusal = refusalOf(t.id);
    return (
      <label key={t.id} className={`post-term${refusal ? ' failed' : ''}`}>
        {/* Marked while a change to it was refused: the writer counts it as not saved, and Publish waits for it. */}
        <input type="checkbox" data-term={t.id} checked={ticked(t.id)} aria-invalid={!!refusal || undefined} aria-describedby={refusal ? failedId(refusal) : undefined} onChange={(e) => toggle(t.id, e.target.checked, t.label)} />
        <span>{t.label}</span>
      </label>
    );
  };
  /** Take a chosen term off with its chip, the caret on the next chip (or the field when none is left). */
  const removeChip = (i: number, t: { id: string; label: string }) => {
    toggle(t.id, false, t.label);
    requestAnimationFrame(() => {
      const left = group.current?.querySelectorAll<HTMLButtonElement>('.post-term-chip button');
      (left?.length ? left[Math.min(i, left.length - 1)] : field.current)?.focus();
    });
  };
  /** After answering a refusal, the caret on the box it was about (the field when filtering hides it, or for an add). */
  const backTo = (f: Failure) =>
    requestAnimationFrame(() => ((f.kind === 'toggle' && group.current?.querySelector<HTMLElement>(`input[data-term="${CSS.escape(f.id)}"]`)) || field.current)?.focus());
  const addRefused = typed ? failures.find((f) => f.kind === 'add' && f.label.toLowerCase() === needle) : undefined;
  const lastAdded = added && terms.find((t) => t.label.trim().toLowerCase() === added.label.toLowerCase());
  // What Enter will do with what is typed, said as it changes (and what the last add did), so it never surprises.
  const hint = !typed
    ? lastAdded && ticked(lastAdded.id)
      ? added!.created
        ? `Added “${lastAdded.label}” and filed this ${entry} under it.`
        : `Filed this ${entry} under “${lastAdded.label}”.`
      : ''
    : same
      ? ticked(same.id)
        ? `This ${entry} is already filed under “${same.label}”.`
        : `Enter files this ${entry} under “${same.label}”.`
      : `Enter adds “${typed}” as a new ${noun}.`;
  const addRow = (
    <div className="post-terms-add">
      {many && <Search className="post-terms-find" aria-hidden="true" />}
      <input
        ref={field}
        className={`input sm${many ? ' with-icon' : ''}`}
        placeholder={many ? `Find or add a ${noun}` : `New ${noun}`}
        aria-label={many ? `Find or add a ${noun} for this ${entry}` : `Add a ${noun} to this ${entry}`}
        aria-describedby={[addRefused && failedId(addRefused), hint && `${uid}-hint`].filter(Boolean).join(' ') || undefined}
        maxLength={80}
        value={name}
        aria-invalid={!!addRefused || undefined}
        onChange={(e) => (setName(e.target.value), setAdded(null), setAgain(''))}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || isImeComposing(e)) return;
          e.preventDefault();
          void submit();
        }}
      />
      <button type="button" className="btn btn-sm post-terms-add-btn" disabled={!canAdd} onClick={() => void submit()}>
        {choose ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />} {choose ? 'Choose' : 'Add'}
      </button>
    </div>
  );
  // Seen beside the field; heard through the status below, which stays in one place whatever the layout.
  // Over a long list the line is always there (so the list never drops as you type), saying what the field is for.
  const hintLine = (
    <p id={`${uid}-hint`} className="post-terms-hint">
      {hint || (many ? `Type to find a ${noun}, or a new name to add one.` : '')}
    </p>
  );
  const failedLine = (f: Failure) => (
    <p key={failureKey(f)} id={failedId(f)} className="field-error post-terms-failed" role="alert">
      <span>{f.kind === 'add' && !f.termId ? `“${f.label}” could not be added.` : f.kind === 'add' || f.on ? `This ${entry} could not be filed under “${f.label}”.` : `This ${entry} could not be taken out of “${f.label}”.`}</span>
      <span className="post-terms-failed-actions">
        <button type="button" className="link-btn" aria-disabled={retrying.includes(failureKey(f)) || undefined} onClick={(e) => void retry(f, e.currentTarget)}>
          Try again<span className="sr-only"> with “{f.label}”</span>
        </button>
        <button type="button" className="link-btn" onClick={() => (settle(failureKey(f)), backTo(f))}>
          Leave it<span className="sr-only"> for “{f.label}”</span>
        </button>
      </span>
    </p>
  );
  const toggleLines = failures.filter((f) => f.kind === 'toggle').map(failedLine);
  const addLines = failures.filter((f) => f.kind === 'add').map(failedLine);
  const list =
    terms.length > 0 &&
    (many ? (
      <div className="post-terms-list many">
        {noMatch && (
          <p className="post-terms-none" aria-hidden="true">
            No {plural} match “{typed}”.
          </p>
        )}
        {shown.map(box)}
      </div>
    ) : (
      <div className="post-terms-list">{terms.map(box)}</div>
    ));
  const fieldBlock = (
    <div className={`post-terms-field${many ? ' many' : ''}`}>
      {addRow}
      {hintLine}
      {addLines}
    </div>
  );
  return (
    <div ref={group} className="post-terms" role="group" aria-labelledby={`${uid}-label`} data-taxonomy={taxonomy.id}>
      <span id={`${uid}-label`} className="post-terms-label">
        {taxonomy.label}
        {many && <span className="post-terms-count">{picked.length ? `${picked.length} of ${terms.length} chosen` : `${terms.length}, none chosen`}</span>}
      </span>
      {/* Mounted from the start and in the same place in both layouts, so what it says is heard when it changes. */}
      <span className="sr-only" role="status">
        {noMatch ? `No ${plural} match. ` : ''}
        {hint} {again}
      </span>
      {many ? (
        <>
          {/* With many terms, those chosen stay together above the list, each removable. */}
          {picked.length > 0 && (
            <ul className="post-term-chips" aria-label={`Chosen ${plural}`}>
              {picked.map((t, i) => (
                <li key={t.id} className="post-term-chip">
                  <span className="ellipsis" title={t.label}>
                    {t.label}
                  </span>
                  <button type="button" className="icon-btn sm" aria-label={`Remove “${t.label}”`} title="Remove" onClick={() => removeChip(i, t)}>
                    <X />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {fieldBlock}
          {/* Between the chips and the list, near both places the change can come from. */}
          {toggleLines}
          {list}
        </>
      ) : (
        <>
          {list}
          {toggleLines}
          {fieldBlock}
        </>
      )}
    </div>
  );
}

/** A refused change: a box ticked or unticked, or a name added. */
type Failure = { kind: 'toggle'; id: string; on: boolean; label: string } | { kind: 'add'; label: string; termId?: string };
const failureKey = (f: Failure) => (f.kind === 'toggle' ? `toggle:${f.id}` : `add:${f.label.toLowerCase()}`);

/**
 * Categories and tags of a collection, one grouping per tab: add a term, rename one (its address follows its name,
 * and the posts and lists of posts that use it follow it), or delete one, saying first how many posts it is on.
 */
export function TermsManager({ collectionId, onClose, onRenamed }: { collectionId: string; onClose: () => void; onRenamed?: (taxonomyId: string, from: string, to: string) => void }) {
  const snap = useStore((s) => s.snapshot);
  const uid = useId();
  const [tab, setTab] = useState('categories');
  /** Saves the rename open in the list, if one is: false when it could not be saved. */
  const finish = useRef<(() => Promise<boolean>) | null>(null);
  const collection = snap?.state.collections[collectionId];
  if (!snap || !collection) return null;
  const groupings = postTaxonomies(collection);
  if (!groupings.length) return null;
  const current = groupings.some((g) => g.id === tab) ? tab : groupings[0].id;
  // Done keeps a name being typed in a rename: it is saved first, and the dialog stays open if it could not be.
  const done = async () => {
    if (finish.current && !(await finish.current())) return;
    onClose();
  };
  return (
    <Modal
      title={termsManagerTitle(collection)}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={() => void done()}>
          Done
        </button>
      }
    >
      <Tabs
        value={current}
        onChange={(v) => void (async () => (!finish.current || (await finish.current())) && setTab(v))()}
        label={termsManagerTitle(collection)}
        idBase={`${uid}-tabs`}
        options={groupings.map((g) => ({ value: g.id, label: g.label, panel: () => <TermList key={g.id} collection={collection} taxonomy={g} onRenamed={onRenamed} finish={finish} /> }))}
      />
    </Modal>
  );
}

function TermList({
  collection,
  taxonomy,
  onRenamed,
  finish
}: {
  collection: Collection;
  taxonomy: { id: string; label: string };
  onRenamed?: (taxonomyId: string, from: string, to: string) => void;
  /** Set to this list's rename while one is open, so Done can save it. */
  finish: { current: (() => Promise<boolean>) | null };
}) {
  const uid = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ termId: string; text: string } | null>(null);
  /** The one category whose archive description is open to edit. */
  const [describing, setDescribing] = useState<string | null>(null);
  /** The name the last add made, said until something else is typed (or the term is gone). */
  const [made, setMade] = useState('');
  const addField = useRef<HTMLInputElement>(null);
  // Gone with its tab: Done never saves a rename from a list no longer shown.
  useEffect(() => () => void (finish.current = null), [finish]);
  const collectionId = collection.settings.id;
  const noun = termNoun(taxonomy.id);
  const plural = taxonomy.label.toLowerCase();
  const terms = termsOf(collection, taxonomy.id);
  const state = useStore((s) => s.snapshot?.state);
  const site = state?.site;
  const archived = taxonomy.id === 'categories' && hasArchivePages(collection.settings) && collection.settings.categoryArchives !== false;
  const archiveOf = (termId: string) => archiveRoute(collection.settings.route ?? '', termId, 1);

  const taken = name.trim() ? termCalled(collection, taxonomy.id, name) : undefined;
  const create = async () => {
    const label = name.trim();
    if (!label || busy || taken) return;
    setBusy(true);
    const r = await commitOps([{ type: 'collection.createTerm', collectionId, taxonomyId: taxonomy.id, label }], `Add ${noun} “${label}”`);
    setBusy(false);
    if (!r?.ok) return;
    setName('');
    setMade(label);
    // The new row is last in the list: brought into view, the caret back in the field for the next name.
    const termId = (r.results?.[0] as { termId?: string } | undefined)?.termId;
    requestAnimationFrame(() => {
      if (termId) document.querySelector(`.term-row[data-term="${CSS.escape(termId)}"]`)?.scrollIntoView({ block: 'nearest' });
      const at = document.activeElement;
      if (!at || at === document.body || at.closest('.terms-add')) addField.current?.focus();
    });
  };
  const madeNow = made && terms.some((t) => t.label === made) ? `Added “${made}”.` : '';
  const addNote = taken ? `There is already a ${noun} called “${taken.label}”.` : madeNow;

  /** Focus a term's Rename button once the list has drawn, or the new-name field when it is gone. */
  const focusRow = (termId: string | undefined) =>
    requestAnimationFrame(() => ((termId && document.querySelector<HTMLElement>(`.term-row[data-term="${CSS.escape(termId)}"] .term-rename-btn`)) || addField.current)?.focus());

  /** Stop renaming, the caret back on the term's Rename button. */
  const stopEditing = (termId: string) => {
    setEditing(null);
    setUnnamed(false);
    focusRow(termId);
  };

  /** Set when a rename was asked to save with no name, so the field says it needs one. */
  const [unnamed, setUnnamed] = useState(false);
  /** Another term already called what the rename says (a change of case to its own name is fine). */
  const clash = editing ? terms.find((t) => t.id !== editing.termId && t.label.trim().toLowerCase() === editing.text.trim().toLowerCase()) : undefined;
  /** Save the rename; true when it is saved or there was nothing to save. */
  const rename = async (): Promise<boolean> => {
    if (!editing) return true;
    if (busy) return false;
    const label = editing.text.trim();
    const was = terms.find((t) => t.id === editing.termId);
    if (!was) return true;
    // Kept open, the caret in the field, which says why.
    const stay = () => (requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.term-row.editing .term-name-input')?.focus()), false);
    if (!label) return (setUnnamed(true), stay());
    if (clash) return stay();
    if (label === was.label) return (stopEditing(was.id), true);
    setBusy(true);
    const r = await commitOps([{ type: 'collection.renameTerm', collectionId, taxonomyId: taxonomy.id, termId: editing.termId, label }], `Rename ${noun} “${was.label}”`);
    setBusy(false);
    if (!r?.ok) return false;
    const to = (r.results?.[0] as { termId?: string } | undefined)?.termId ?? editing.termId;
    stopEditing(to);
    onRenamed?.(taxonomy.id, editing.termId, to);
    toast(`Renamed “${was.label}” to “${label}”`, 'info', undoAction(r));
    return true;
  };
  finish.current = editing ? rename : null;

  const remove = async (termId: string) => {
    const s = getState().snapshot;
    const c = s?.state.collections[collectionId];
    const all = termsOf(c, taxonomy.id);
    const term = all.find((t) => t.id === termId);
    if (!s || !c || !term) return;
    // A list of posts that chooses it would list nothing without it: said on the row, and again here if asked.
    const uses = termFeedUses(s.state, collectionId, taxonomy.id, termId);
    if (uses.length) return toast(`${uses.map((u) => u.where).join(', ')} ${uses.length === 1 ? 'lists' : 'list'} posts by “${term.label}”. Choose something else there before deleting it.`, 'error');
    const n = entriesWithTerm(c, taxonomy.id, termId).length;
    const filed = n ? `${posts(n)} ${n === 1 ? 'is' : 'are'} filed under it. ${n === 1 ? 'It stays' : 'They stay'}, without this ${noun}.` : `No post is filed under it.`;
    const ok = await confirmDialog({
      title: `Delete this ${noun}?`,
      body: archived ? `${filed} Its archive page, ${archiveOf(termId)}, goes with it.` : filed,
      confirmLabel: `Delete ${noun}`,
      danger: true,
      icon: 'delete',
      subject: term.label,
      details: [{ kind: 'undo', text: 'You can undo it.' }]
    });
    if (!ok) return;
    const at = all.findIndex((t) => t.id === termId);
    const neighbour = all[at + 1]?.id ?? all[at - 1]?.id;
    // Against the project the count was read from: a post filed under it meanwhile is counted again.
    const r = await commitOps([{ type: 'collection.removeTerm', collectionId, taxonomyId: taxonomy.id, termId }], `Delete ${noun} “${term.label}”`, undefined, s.revision, { replanStale: true });
    if (r && !r.ok) {
      if (r.error?.code === 'STALE_REVISION') toast('The posts changed while you were deciding. Delete it again to see how many are filed under it now.', 'error');
      return;
    }
    if (r?.ok) {
      focusRow(neighbour);
      toast(`Deleted “${term.label}”`, 'info', undoAction(r));
    }
  };

  return (
    <div className="terms-panel" data-taxonomy={taxonomy.id}>
      <form
        className="terms-add"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          ref={addField}
          className="input"
          placeholder={`New ${noun} name`}
          aria-label={`New ${noun} name`}
          aria-describedby={taken ? `${uid}-add-note` : undefined}
          aria-invalid={!!taken || undefined}
          maxLength={80}
          value={name}
          readOnly={busy}
          onChange={(e) => (setName(e.target.value), setMade(''))}
        />
        <button type="submit" className="btn" disabled={!name.trim() || busy || !!taken}>
          <Plus aria-hidden="true" /> Add {noun}
        </button>
      </form>
      <span className="sr-only" role="status">
        {addNote}
      </span>
      {taken ? (
        <p className="field-error terms-note" id={`${uid}-add-note`}>
          {addNote}
        </p>
      ) : (
        madeNow && (
          <p className="terms-made terms-note" aria-hidden="true">
            {madeNow}
          </p>
        )
      )}
      {!terms.length ? (
        <p className="terms-empty">
          No {plural} yet. Add the first one above, or type a new {noun} while writing a post.
        </p>
      ) : (
        <ul className="terms-list" aria-label={taxonomy.label}>
          {terms.map((t) => {
            const n = entriesWithTerm(collection, taxonomy.id, t.id).length;
            const open = editing?.termId === t.id;
            const next = open ? termIdFor(collection.settings.taxonomies?.[taxonomy.id]?.terms ?? {}, editing.text, t.id, assignedTermIds(collection, taxonomy.id)) : t.id;
            const moves = open && archived && editing.text.trim() && editing.text.trim() !== t.label && next !== t.id;
            const uses = state ? termFeedUses(state, collectionId, taxonomy.id, t.id) : [];
            const description = collection.settings.taxonomies.categories?.terms[t.id]?.description ?? '';
            const describe = !open && archived && !!site && describing === t.id;
            const main = (
              <span className="term-main">
                {open ? (
                  <input
                    className="input sm term-name-input"
                    aria-label={`New name for “${t.label}”`}
                    aria-describedby={clash || (unnamed && !editing.text.trim()) ? `${uid}-${t.id}-clash` : moves ? `${uid}-${t.id}-moves` : undefined}
                    aria-invalid={!!clash || (unnamed && !editing.text.trim()) || undefined}
                    maxLength={80}
                    value={editing.text}
                    readOnly={busy}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setEditing({ termId: t.id, text: e.target.value })}
                  />
                ) : (
                  <span className="term-label ellipsis">{t.label}</span>
                )}
                <span className="term-facts">
                  <span className="term-meta">
                    {posts(n)}
                    {archived && !moves ? ` · ${archiveOf(t.id)}` : ''}
                  </span>
                  {!open && archived && site && (
                    <button type="button" className="term-describe" aria-expanded={describe} aria-controls={`${uid}-${t.id}-describe`} onClick={() => (setDescribing(describe ? null : t.id), describe || requestAnimationFrame(() => document.getElementById(`${uid}-${t.id}-describe`)?.querySelector('textarea')?.focus()))}>
                      <ChevronRight className="term-describe-chevron" aria-hidden="true" />
                      Description<span className="sr-only"> of the “{t.label}” archive</span>
                      {!describe && <span className={`term-describe-value ellipsis${description ? ' set' : ''}`}>{description ? description : 'Default wording'}</span>}
                    </button>
                  )}
                </span>
                {open && (clash || (unnamed && !editing.text.trim())) && (
                  <span className="field-error term-clash" id={`${uid}-${t.id}-clash`} role="alert">
                    {clash ? `There is already a ${noun} called “${clash.label}”.` : `Enter a ${noun} name.`}
                  </span>
                )}
                {moves && !clash && (
                  <span className="term-moves" id={`${uid}-${t.id}-moves`}>
                    Its archive moves from {archiveOf(t.id)} to {archiveOf(next)}. Its posts and lists of posts follow it.
                  </span>
                )}
                {uses.length > 0 && !open && (
                  <span className="term-blocked" id={`${uid}-${t.id}-blocked`}>
                    {uses.map((u) => u.where).join(', ')} {uses.length === 1 ? 'lists' : 'list'} posts by it. Choose something else there to delete it.
                  </span>
                )}
                {describe && (
                  <span className="term-describe-field" id={`${uid}-${t.id}-describe`}>
                    <DraftInput
                      multiline
                      rows={2}
                      className="textarea"
                      limit={TEXT_LIMITS.pageDescription}
                      keep={`collection:${collectionId}:category:${t.id}:description`}
                      keepWhile={() => {
                        // Only while the category has its archive, so a draft hidden by turning archives off is offered to copy.
                        const c = getState().snapshot?.state.collections[collectionId];
                        return !!c && hasArchivePages(c.settings) && c.settings.categoryArchives !== false && Object.hasOwn(c.settings.taxonomies?.categories?.terms ?? {}, t.id);
                      }}
                      ariaLabel={`Archive description of “${t.label}”, for search engines and link previews`}
                      value={description}
                      placeholder={defaultArchiveDescription({ site: site!, collections: { [collectionId]: collection } }, collectionId, t.id)}
                      onCommit={(v) => commitOps([{ type: 'collection.update', collectionId, categoryDescription: { termId: t.id, description: v } }], `Change the “${t.label}” archive description`)}
                    />
                    <span className="term-describe-hint">For search engines and link previews of {archiveOf(t.id)}. Left empty, they get the wording shown.</span>
                  </span>
                )}
              </span>
            );
            const actions = open ? (
              <span className="term-actions">
                <button type="submit" className="icon-btn sm" aria-label="Save name" title="Save (Enter)" disabled={!editing.text.trim() || busy || !!clash}>
                  <Check />
                </button>
                <button type="button" className="icon-btn sm" aria-label="Cancel renaming" title="Cancel (Esc)" onClick={() => stopEditing(t.id)}>
                  <X />
                </button>
              </span>
            ) : (
              <span className="term-actions">
                <button className="icon-btn sm term-rename-btn" aria-label={`Rename “${t.label}”`} title="Rename" onClick={() => void (async () => (!editing || (await rename())) && (setDescribing(null), setEditing({ termId: t.id, text: t.label })))()}>
                  <Pencil />
                </button>
                <button
                  className="icon-btn sm"
                  aria-label={`Delete “${t.label}”`}
                  aria-disabled={uses.length > 0 || undefined}
                  aria-describedby={uses.length ? `${uid}-${t.id}-blocked` : undefined}
                  title={uses.length ? 'A list of posts uses it' : 'Delete'}
                  onClick={() => void remove(t.id)}
                >
                  <Trash2 />
                </button>
              </span>
            );
            return (
              <li key={t.id} className={`term-row${open ? ' editing' : ''}`} data-term={t.id}>
                {open ? (
                  <form
                    className="term-rename"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename();
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape' && !isImeComposing(e)) (e.stopPropagation(), stopEditing(t.id));
                    }}
                  >
                    {main}
                    {actions}
                  </form>
                ) : (
                  <>
                    {main}
                    {actions}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
