import './PostTerms.css';
import { useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
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
      refused();
      toast('The post kept changing while its categories were being saved. Try again.', 'error');
      return null;
    };
    const run = async (): Promise<Sent | undefined> => {
      try {
        return await attempt();
      } catch {
        refused();
        toast('That category or tag change could not be saved.', 'error');
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
        : { ops: [{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, terms: { [taxonomyId]: on ? [...ids, termId] : ids.filter((id) => id !== termId) } }], label: `${on ? 'File post under' : 'Take post out of'} “${label}”` }
    );
  const add = (taxonomyId: string, label: string) =>
    change(taxonomyId, (c, ids) => {
      const existing = termCalled(c, taxonomyId, label);
      if (existing) return ids.includes(existing.id) ? null : { ops: [{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, terms: { [taxonomyId]: [...ids, existing.id] } }], label: `File post under “${existing.label}”` };
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
          onToggle={(id, on, label) => toggle(t.id, id, on, label)}
          onAdd={(label) => add(t.id, label)}
        />
      ))}
    </>
  );
}

function TermChecks({
  taxonomy,
  terms,
  chosen,
  revision,
  onToggle,
  onAdd
}: {
  taxonomy: { id: string; label: string };
  terms: Array<{ id: string; label: string }>;
  chosen: string[];
  revision: number;
  onToggle: (termId: string, on: boolean, label: string) => Promise<Sent | undefined>;
  onAdd: (label: string) => Promise<Sent | undefined>;
}) {
  const uid = useId();
  const [name, setName] = useState('');
  /**
   * Ticks on their way, shown until the project has them: the latest click on each box (`seq`), and once it has landed
   * the revision it made, from which the project's own copy decides again.
   */
  const [pending, setPending] = useState<Record<string, { on: boolean; seq: number; landedAt?: number }>>({});
  const clicks = useRef(0);
  const chosenKey = chosen.join('\n');
  useEffect(() => {
    setPending((p) => {
      const kept = Object.entries(p).filter(([id, x]) => x.landedAt === undefined || (revision < x.landedAt && x.on !== chosen.includes(id)));
      return kept.length === Object.keys(p).length ? p : Object.fromEntries(kept);
    });
  }, [chosenKey, revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = (id: string, on: boolean, label: string) => {
    const seq = ++clicks.current;
    setPending((p) => ({ ...p, [id]: { on, seq } }));
    void onToggle(id, on, label).then((r) =>
      setPending((p) => {
        if (p[id]?.seq !== seq) return p;
        // Refused: the project's own state shows again. Landed: shown until the project's copy has caught up with it.
        if (r === null || (r && !r.ok)) {
          const { [id]: _gone, ...rest } = p;
          return rest;
        }
        // The project's copy may already be here, with this change or a later one: it decides from now.
        const landedAt = r?.revision ?? 0;
        if ((getState().snapshot?.revision ?? 0) >= landedAt) {
          const { [id]: _done, ...rest } = p;
          return rest;
        }
        return { ...p, [id]: { on, seq, landedAt } };
      })
    );
  };
  const ticked = (id: string) => (Object.hasOwn(pending, id) ? pending[id].on : chosen.includes(id));
  const noun = termNoun(taxonomy.id);
  const submit = async () => {
    const label = name.trim();
    if (!label) return;
    const r = await onAdd(label);
    // Kept when refused, to try again; anything typed meanwhile is never cleared.
    if (r !== null) setName((n) => (n.trim() === label ? '' : n));
  };
  return (
    <div className="post-terms" role="group" aria-labelledby={`${uid}-label`} data-taxonomy={taxonomy.id}>
      <span id={`${uid}-label`} className="post-terms-label">
        {taxonomy.label}
      </span>
      {terms.length > 0 && (
        <div className="post-terms-list">
          {terms.map((t) => (
            <label key={t.id} className="post-term">
              <input type="checkbox" checked={ticked(t.id)} onChange={(e) => toggle(t.id, e.target.checked, t.label)} />
              <span>{t.label}</span>
            </label>
          ))}
        </div>
      )}
      <input
        className="input sm post-terms-add"
        placeholder={`Add a ${noun}`}
        aria-label={`Add a ${noun} to this post`}
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || isImeComposing(e)) return;
          e.preventDefault();
          void submit();
        }}
      />
    </div>
  );
}

/**
 * Categories and tags of a collection, one grouping per tab: add a term, rename one (its address follows its name,
 * and the posts and lists of posts that use it follow it), or delete one, saying first how many posts it is on.
 */
export function TermsManager({ collectionId, onClose, onRenamed }: { collectionId: string; onClose: () => void; onRenamed?: (taxonomyId: string, from: string, to: string) => void }) {
  const snap = useStore((s) => s.snapshot);
  const uid = useId();
  const [tab, setTab] = useState('categories');
  const collection = snap?.state.collections[collectionId];
  if (!snap || !collection) return null;
  const groupings = postTaxonomies(collection);
  if (!groupings.length) return null;
  const current = groupings.some((g) => g.id === tab) ? tab : groupings[0].id;
  return (
    <Modal
      title={termsManagerTitle(collection)}
      onClose={onClose}
      footer={
        <>
          <span className="grow" />
          <button className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </>
      }
    >
      <Tabs
        value={current}
        onChange={setTab}
        label="Groupings"
        idBase={`${uid}-tabs`}
        options={groupings.map((g) => ({ value: g.id, label: g.label, panel: () => <TermList key={g.id} collection={collection} taxonomy={g} onRenamed={onRenamed} /> }))}
      />
    </Modal>
  );
}

function TermList({ collection, taxonomy, onRenamed }: { collection: Collection; taxonomy: { id: string; label: string }; onRenamed?: (taxonomyId: string, from: string, to: string) => void }) {
  const uid = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ termId: string; text: string } | null>(null);
  const collectionId = collection.settings.id;
  const noun = termNoun(taxonomy.id);
  const terms = termsOf(collection, taxonomy.id);
  const site = useStore((s) => s.snapshot?.state.site);
  const archived = taxonomy.id === 'categories' && hasArchivePages(collection.settings) && collection.settings.categoryArchives !== false;

  const create = async () => {
    const label = name.trim();
    if (!label || busy) return;
    setBusy(true);
    const r = await commitOps([{ type: 'collection.createTerm', collectionId, taxonomyId: taxonomy.id, label }], `Add ${noun} “${label}”`);
    setBusy(false);
    if (r?.ok) setName('');
  };

  /** Stop renaming, the caret back on the term's Rename button. */
  const stopEditing = (termId: string) => {
    setEditing(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.term-row[data-term="${termId}"] .term-rename-btn`)?.focus());
  };

  const rename = async () => {
    if (!editing || busy) return;
    const label = editing.text.trim();
    const was = terms.find((t) => t.id === editing.termId);
    if (!label || !was) return;
    if (label === was.label) return stopEditing(was.id);
    setBusy(true);
    const r = await commitOps([{ type: 'collection.renameTerm', collectionId, taxonomyId: taxonomy.id, termId: editing.termId, label }], `Rename ${noun} “${was.label}”`);
    setBusy(false);
    if (!r?.ok) return;
    const to = (r.results?.[0] as { termId?: string } | undefined)?.termId ?? editing.termId;
    stopEditing(to);
    onRenamed?.(taxonomy.id, editing.termId, to);
    toast(`Renamed “${was.label}” to “${label}”`, 'info', undoAction(r));
  };

  const remove = async (termId: string) => {
    const s = getState().snapshot;
    const c = s?.state.collections[collectionId];
    const term = termsOf(c, taxonomy.id).find((t) => t.id === termId);
    if (!s || !c || !term) return;
    // A list of posts that chooses it would list nothing without it: where to change that is said first.
    const uses = termFeedUses(s.state, collectionId, taxonomy.id, termId);
    if (uses.length) return toast(`${uses.map((u) => u.where).join(', ')} ${uses.length === 1 ? 'lists' : 'list'} posts by “${term.label}”. Choose something else there before deleting it.`, 'error');
    const n = entriesWithTerm(c, taxonomy.id, termId).length;
    const ok = await confirmDialog({
      title: `Delete this ${noun}?`,
      body: n ? `${posts(n)} ${n === 1 ? 'is' : 'are'} filed under it. ${n === 1 ? 'It stays' : 'They stay'}, without this ${noun}.` : `No post is filed under it.`,
      confirmLabel: `Delete ${noun}`,
      danger: true,
      icon: 'delete',
      subject: term.label,
      details: [{ kind: 'undo', text: 'You can undo it.' }]
    });
    if (!ok) return;
    // Against the project the count was read from: a post filed under it meanwhile is counted again.
    const r = await commitOps([{ type: 'collection.removeTerm', collectionId, taxonomyId: taxonomy.id, termId }], `Delete ${noun} “${term.label}”`, undefined, s.revision, { replanStale: true });
    if (r && !r.ok) {
      if (r.error?.code === 'STALE_REVISION') toast('The posts changed while you were deciding. Delete it again to see how many are filed under it now.', 'error');
      return;
    }
    if (r?.ok) toast(`Deleted “${term.label}”`, 'info', undoAction(r));
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
        <input className="input" placeholder={`New ${noun} name`} aria-label={`New ${noun} name`} maxLength={80} value={name} readOnly={busy} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-sm" disabled={!name.trim() || busy}>
          <Plus aria-hidden="true" /> Add {noun}
        </button>
      </form>
      {!terms.length && <p className="posts-note">No {taxonomy.label.toLowerCase()} yet.</p>}
      <ul className="terms-list" aria-label={taxonomy.label}>
        {terms.map((t) => {
          const n = entriesWithTerm(collection, taxonomy.id, t.id).length;
          const open = editing?.termId === t.id;
          const next = open ? termIdFor(collection.settings.taxonomies?.[taxonomy.id]?.terms ?? {}, editing.text, t.id, assignedTermIds(collection, taxonomy.id)) : t.id;
          return (
            <li key={t.id} className="term-row" data-term={t.id}>
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
                  <input className="input sm" aria-label={`New name for “${t.label}”`} maxLength={80} value={editing.text} readOnly={busy} autoFocus onChange={(e) => setEditing({ termId: t.id, text: e.target.value })} />
                  <button type="submit" className="icon-btn sm" aria-label="Save name" title="Save" disabled={!editing.text.trim() || busy}>
                    <Check />
                  </button>
                  <button type="button" className="icon-btn sm" aria-label="Cancel renaming" title="Cancel (Esc)" onClick={() => stopEditing(t.id)}>
                    <X />
                  </button>
                  {archived && editing.text.trim() && editing.text.trim() !== t.label && next !== t.id && (
                    <p className="term-moves" id={`${uid}-${t.id}-moves`}>
                      Its archive moves from {archiveRoute(collection.settings.route ?? '', t.id, 1)} to {archiveRoute(collection.settings.route ?? '', next, 1)}. Its posts and lists of posts follow it.
                    </p>
                  )}
                </form>
              ) : (
                <>
                  <span className="term-name">
                    <span className="term-label ellipsis">{t.label}</span>
                    <span className="term-meta">
                      {posts(n)}
                      {archived ? ` · ${archiveRoute(collection.settings.route ?? '', t.id, 1)}` : ''}
                    </span>
                    {archived && site && (
                      <label className="term-description">
                        Archive description
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
                          ariaLabel={`What the “${t.label}” archive tells search engines and link previews`}
                          value={collection.settings.taxonomies.categories?.terms[t.id]?.description ?? ''}
                          placeholder={defaultArchiveDescription({ site, collections: { [collectionId]: collection } }, collectionId, t.id)}
                          onCommit={(v) => commitOps([{ type: 'collection.update', collectionId, categoryDescription: { termId: t.id, description: v } }], `Change the “${t.label}” archive description`)}
                        />
                      </label>
                    )}
                  </span>
                  <span className="term-actions">
                    <button className="icon-btn sm term-rename-btn" aria-label={`Rename “${t.label}”`} title="Rename" onClick={() => setEditing({ termId: t.id, text: t.label })}>
                      <Pencil />
                    </button>
                    <button className="icon-btn sm" aria-label={`Delete “${t.label}”`} title="Delete" onClick={() => void remove(t.id)}>
                      <Trash2 />
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
