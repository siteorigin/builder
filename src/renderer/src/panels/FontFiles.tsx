import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileSearch, Trash2, TriangleAlert } from 'lucide-react';
import type { AssetRecord, ProjectState } from '@shared/types';
import type { MissingAssetFiles } from '@shared/api';
import { familyUses, importedFontStack, sameFontFamily, type FontUse } from '@shared/fonts';
import { scriptLabels } from '@shared/font-scripts';
import { effectiveTokens } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { api, applyOps, commitOps, toast, undoAction, useStore } from '../store';
import { DisclosureMark, DraftInput, Modal } from '../components/ui';
import { openSiteStyles } from '../lib/actions';
import { formatBytes, plural } from '../lib/storage';
import { usePreviewStack, useEditorFontFile, useEditorFontFiles, type EditorFontFile } from '../lib/editor-fonts';
import { FontSelect, familyName } from './FontSelect';

const WEIGHTS: Array<[string, string]> = [
  ['100', 'Thin'], ['200', 'Extra light'], ['300', 'Light'], ['400', 'Regular'], ['500', 'Medium'], ['600', 'Semibold'], ['700', 'Bold'], ['800', 'Extra bold'], ['900', 'Black']
];
/** "Bold italic", "Variable (100–900)". */
function faceLabel(a: AssetRecord): string {
  const w = a.font?.weight ?? '400';
  const weight = w.includes(' ') ? `Variable (${w.replace(' ', '–')})` : (WEIGHTS.find(([v]) => v === w)?.[1] ?? w);
  return a.font?.style === 'italic' ? `${weight} italic` : weight;
}
/** The file's own name in the project, which keeps the name it was imported with ("lora-cyrillic-…woff2"). */
export const fontFileName = (a: AssetRecord) => a.file.split('/').pop() ?? a.file;
/** The name of the file it was imported from, when that was kept (assets.json can be edited by hand), else its own. */
const importedName = (a: AssetRecord) => (typeof a.originalName === 'string' && a.originalName.trim()) || fontFileName(a);
/** The alphabets a file covers, as read from it; null while it loads or when that can't be read. */
function coverageText(f: EditorFontFile | null): string | null {
  if (f?.status !== 'ready' || !f.coverage) return null;
  return f.coverage.scripts.length ? scriptLabels(f.coverage.scripts).join(', ') : 'No full alphabet';
}
const weightRange = (w: string): [number, number] => {
  const [lo, hi] = w.split(' ').map(Number);
  return [lo, hi ?? lo];
};
/** A weight a file draws without the browser faking it: 400 when a variable file covers it. */
function sampleWeight(w: string): number {
  const [lo, hi] = weightRange(w);
  return lo <= 400 && hi >= 400 ? 400 : lo;
}

/** A few characters drawn in this file alone, so files of one family can be told apart by eye. */
function FontSample({ a }: { a: AssetRecord }) {
  const f = useEditorFontFile(a.id);
  if (!f || f.status === 'loading') return <div className="font-face-sample muted">Loading preview…</div>;
  if (f.status === 'failed' || !f.coverage?.sample) return <div className="font-face-sample muted">Preview unavailable</div>;
  return (
    <div className="font-face-sample" data-font-sample={a.id} style={{ fontFamily: f.alias, fontWeight: sampleWeight(a.font!.weight), fontStyle: a.font!.style }}>
      {f.coverage.sample}
    </div>
  );
}

/** Files of one family together, upright before italic and lighter before heavier, so a family reads top to bottom. */
function groupFamilies(fonts: AssetRecord[]): AssetRecord[][] {
  const byFamily = new Map<string, AssetRecord[]>();
  for (const a of fonts) {
    const key = (a.font?.family ?? a.name).toLowerCase();
    byFamily.set(key, [...(byFamily.get(key) ?? []), a]);
  }
  const order = (a: AssetRecord) => [a.font?.style === 'italic' ? 1 : 0, weightRange(a.font?.weight ?? '400')[0]];
  return [...byFamily.values()]
    .map((faces) =>
      faces.sort((x, y) => {
        const [sx, wx] = order(x);
        const [sy, wy] = order(y);
        return sx - sy || wx - wy || importedName(x).localeCompare(importedName(y));
      })
    )
    .sort((x, y) => (x[0].font?.family ?? '').localeCompare(y[0].font?.family ?? ''));
}

/** A family's identity in the list: its earliest file's ID, which neither a rename nor a change of face moves. */
const familyKey = (faces: AssetRecord[]) => faces.reduce((min, a) => (a.id < min ? a.id : min), faces[0].id);

/** Where a family is used, as briefly as a family header can say it: the site styles by name, everything else counted. */
function usedFor(state: ProjectState, family: string): string | null {
  const fontTokens = new Set(getTheme(state.site.themeId).tokens.filter((t) => t.group === 'font').map((t) => t.id));
  const uses = familyUses(state, family, fontTokens);
  if (!uses.length) return null;
  const tokens = new Map(effectiveTokens(state).map((t) => [t.id, t.label]));
  const named = [...new Set(uses.flatMap((u) => (u.kind === 'token' && tokens.has(u.tokenId) ? [tokens.get(u.tokenId)!] : [])))];
  const others = uses.length - uses.filter((u) => u.kind === 'token' && tokens.has(u.tokenId)).length;
  if (!named.length) return `Used in ${plural(others, 'place', 'places')}`;
  const list = named.length > 2 ? `${named.slice(0, -1).join(', ')} and ${named.at(-1)}` : named.join(' and ');
  return others ? `Used for ${list}, and in ${plural(others, 'other place', 'other places')}` : `Used for ${list}`;
}

/**
 * Imported web fonts, a card a family: its name, whether the site uses it and where, then each of its files (one face
 * each). A file missing from the project folder (#1425) is flagged on its family and offers Locate file on its row.
 * `reveal` is a font to open its family on and focus (Open in Assets), until `onRevealed` says it was.
 */
export function FontList({
  fonts,
  usage,
  missingOf,
  reveal = null,
  onRevealed
}: {
  fonts: AssetRecord[];
  usage: Record<string, number>;
  missingOf?: ReadonlyMap<string, MissingAssetFiles>;
  reveal?: string | null;
  onRevealed?: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const lost = (a: AssetRecord) => !!missingOf?.get(a.id)?.original;
  const state = useStore((s) => s.snapshot?.state);
  const families = useMemo(() => groupFamilies(fonts), [fonts]);
  // Families start closed (name, status and uses only), so the whole inventory fits on one screen; each opens to its
  // files. A lone family starts open. What the author opened or closed is kept against each of the family's files, so
  // a rename, a re-sort, a removed file or an Undo leaves the card as it was.
  const [shown, setShown] = useState<ReadonlyMap<string, boolean>>(new Map());
  const isOpen = (faces: AssetRecord[]) => faces.map((a) => shown.get(a.id)).find((v) => v !== undefined) ?? families.length === 1;
  const toggle = (faces: AssetRecord[]) =>
    setShown((was) => {
      const next = new Map(was);
      const open = !isOpen(faces);
      for (const a of faces) next.set(a.id, open);
      return next;
    });
  const faceOf = (a: AssetRecord) => ({ family: a.font?.family ?? a.name, weight: a.font?.weight ?? '400', style: a.font?.style ?? ('normal' as const) });
  /** A face's correction can re-sort its row (italic after upright): the control that made it keeps focus. */
  const update = async (a: AssetRecord, patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => {
    const was = document.activeElement instanceof HTMLElement && document.activeElement.closest(`[data-font="${a.id}"]`) ? document.activeElement.id : null;
    await applyOps([{ type: 'asset.update', assetId: a.id, font: { ...faceOf(a), ...patch } }], label);
    if (was) requestAnimationFrame(() => document.getElementById(was)?.focus());
  };
  /** A family is renamed as a whole, so its files stay together and the styles using it follow. */
  const renameFamily = (a: AssetRecord, family: string) =>
    void applyOps(
      fonts.filter((x) => sameFontFamily(x, a)).map((x) => ({ type: 'asset.update' as const, assetId: x.id, font: { ...faceOf(x), family } })),
      `Rename font family to ${family}`
    );
  /**
   * After a file goes, focus moves to the next file of its family (or the one before), else to its family's name when
   * other families are left, else to Add fonts: always somewhere visible, never the page.
   */
  const focusAfter = (a: AssetRecord) => {
    const own = families.find((f) => f.some((x) => x.id === a.id)) ?? [];
    const i = own.findIndex((x) => x.id === a.id);
    const next = own[i + 1] ?? own[i - 1];
    const sibling = families[families.indexOf(own) + 1] ?? families[families.indexOf(own) - 1];
    requestAnimationFrame(
      () =>
        (
          (next && document.querySelector<HTMLElement>(`.font-family-body:not([hidden]) [data-font="${next.id}"] .font-remove:not(:disabled)`)) ||
          (sibling && document.querySelector<HTMLElement>(`[data-font-family-key="${familyKey(sibling)}"] .font-family-toggle`)) ||
          document.querySelector<HTMLElement>('.asset-add')
        )?.focus()
    );
  };
  /** A file of a family the site uses changes how some text is drawn: the author sees what first. */
  const remove = async (a: AssetRecord) => {
    if (usage[a.id]) return setRemoving(a.id);
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id }], `Remove ${a.name}`);
    if (r) {
      toast(`Removed ${a.name}.`, 'info', undoAction(r));
      focusAfter(a);
    }
  };
  // Open in Assets opens the font's family and focuses its row, where the missing file is fixed: once the family is
  // open on screen (the effect below), so a button still in a closed family's hidden body is never the target.
  const focusing = useRef<{ id: string; family: string } | null>(null);
  useEffect(() => {
    if (!reveal) return;
    const own = families.find((f) => f.some((x) => x.id === reveal));
    onRevealed?.();
    if (!own) return;
    focusing.current = { id: reveal, family: familyKey(own) };
    setShown((was) => new Map([...was, ...own.map((x) => [x.id, true] as const)]));
  }, [reveal, families, onRevealed]);
  useEffect(() => {
    const want = focusing.current;
    if (!want) return;
    const button = document.querySelector<HTMLButtonElement>(`[data-font="${want.id}"] .font-locate`);
    // Still in the closed family (this runs in the commit that asked for it to open): the next one shows it.
    if (button?.closest('[hidden]')) return;
    focusing.current = null;
    (button && !button.disabled ? button : document.querySelector<HTMLElement>(`[data-font-family-key="${want.family}"] .font-family-toggle`))?.focus();
  }, [shown]);
  /** Locate file: the font's very file goes back where its record names it, and nothing else changes. */
  const locate = async (a: AssetRecord) => {
    if (locating) return;
    setLocating(true);
    // The button is disabled while the chooser is open, which drops its focus.
    const lostFocus = () => !document.activeElement || document.activeElement === document.body;
    try {
      const r = await api.project.locateAsset(a.id).catch((e: Error) => ({ ok: false, message: e.message }));
      if (r.message) toast(r.message, r.ok ? 'info' : 'error');
    } finally {
      setLocating(false);
      // Focus goes back to Locate file once it is enabled again (a canceled chooser), or, once the file is back and the
      // note has gone, to the family's name: never the page.
      requestAnimationFrame(() => {
        if (!lostFocus()) return;
        const row = document.querySelector<HTMLElement>(`[data-font="${a.id}"]`);
        (row?.querySelector<HTMLElement>('.font-locate') ?? row?.closest<HTMLElement>('.font-family')?.querySelector<HTMLElement>('.font-family-toggle'))?.focus();
      });
    }
  };
  const asking = fonts.find((a) => a.id === removing);
  // A file removed elsewhere closes its question for good: an Undo that brings it back doesn't ask again.
  useEffect(() => {
    if (removing && !asking) setRemoving(null);
  }, [removing, asking]);
  return (
    <section className="font-list" aria-label="Fonts">
      <p className="font-list-note">
        Imported fonts are part of your site. Choose one for headings or body text in{' '}
        <button className="link-btn" onClick={() => openSiteStyles()}>
          Site styles
        </button>
        .
      </p>
      <ul className="font-families">
        {families.map((faces) => (
          <FontFamily
            key={familyKey(faces)}
            faces={faces}
            open={isOpen(faces)}
            onToggle={() => toggle(faces)}
            used={faces.some((a) => usage[a.id])}
            where={state ? usedFor(state, faces[0].font?.family ?? faces[0].name) : null}
            lost={lost}
            locating={locating}
            onRename={(family) => renameFamily(faces[0], family)}
            onUpdate={update}
            onRemove={(a) => void remove(a)}
            onLocate={(a) => void locate(a)}
          />
        ))}
      </ul>
      {asking && <RemoveFontDialog a={asking} onClose={() => setRemoving(null)} onRemoved={() => focusAfter(asking)} />}
    </section>
  );
}

function FontFamily({
  faces,
  open,
  onToggle,
  used,
  where,
  lost,
  locating,
  onRename,
  onUpdate,
  onRemove,
  onLocate
}: {
  faces: AssetRecord[];
  open: boolean;
  onToggle: () => void;
  used: boolean;
  where: string | null;
  lost: (a: AssetRecord) => boolean;
  locating: boolean;
  onRename: (family: string) => void;
  onUpdate: (a: AssetRecord, patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => unknown;
  onRemove: (a: AssetRecord) => void;
  onLocate: (a: AssetRecord) => void;
}) {
  const uid = useId();
  const family = faces[0].font?.family ?? faces[0].name;
  const bytes = faces.reduce((n, a) => n + a.bytes, 0);
  const missing = faces.filter(lost).length;
  const shownStack = usePreviewStack();
  return (
    <li className="font-family" data-font-family={family} data-font-family-key={familyKey(faces)} data-open={open || undefined} aria-labelledby={`${uid}-name`}>
      <div className="font-family-head">
        <div className="font-family-title">
          <h4>
            <button type="button" className="font-family-toggle" aria-expanded={open} aria-controls={`${uid}-body`} onClick={onToggle}>
              <DisclosureMark />
              <span id={`${uid}-name`} style={{ fontFamily: shownStack(importedFontStack(family)) }}>
                {family}
              </span>
            </button>
          </h4>
          <span className={`badge${used ? ' accent' : ''}`}>{used ? 'In use' : 'Not used'}</span>
        </div>
        <p className="font-family-meta">
          {plural(faces.length, 'file', 'files')}
          {missing > 0 && (
            <>
              {' · '}
              <span className="doc-state-alert">{faces.length === 1 ? 'File missing' : `${missing} of ${faces.length} missing`}</span>
            </>
          )}{' '}
          · {formatBytes(bytes)}
          {where ? ` · ${where}` : ''}
        </p>
      </div>
      <div className="font-family-body" id={`${uid}-body`} hidden={!open}>
        <div className="field font-family-name">
          <label htmlFor={`${uid}-family`}>Family name</label>
          <DraftInput
            id={`${uid}-family`}
            className="input sm"
            value={family}
            aria-describedby={`${uid}-scope`}
            onCommit={(v) => {
              const next = v.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60);
              if (!next) return false;
              if (next !== family) onRename(next);
            }}
          />
          <span className="field-hint" id={`${uid}-scope`}>
            {faces.length === 1 ? 'The styles that use it follow the new name.' : `Renames ${faces.length === 2 ? 'both' : `all ${faces.length}`} files, and the styles that use it follow.`}
          </span>
        </div>
        <ul className="font-faces" aria-label={`Files of ${family}`}>
          {faces.map((a) => (
            <FontRow key={a.id} a={a} used={used} lost={lost(a)} locating={locating} onUpdate={(patch, label) => onUpdate(a, patch, label)} onRemove={() => onRemove(a)} onLocate={() => onLocate(a)} />
          ))}
        </ul>
      </div>
    </li>
  );
}

/** What tells a family's files apart at a glance: "Upright · Cyrillic" for a variable file (its weights are a range), "Bold italic · Latin" for a static one. */
function faceParts(a: AssetRecord, covers: string | null): string[] {
  const variable = !!a.font?.weight.includes(' ');
  const face = variable ? (a.font?.style === 'italic' ? 'Italic' : 'Upright') : faceLabel(a);
  return [face, ...(covers && covers !== 'No full alphabet' ? covers.split(', ') : [])];
}
/** The same words inside a sentence: "upright Cyrillic", "bold italic Latin". */
const faceWords = (a: AssetRecord, covers: string | null) => {
  const [face, ...alphabets] = faceParts(a, covers);
  return [face.toLowerCase(), alphabets.join(' and ')].filter(Boolean).join(' ');
};
/** A variable file's weights, "400–700, variable"; a static file's, "700". */
function weightText(a: AssetRecord): string {
  const [lo, hi] = weightRange(a.font?.weight ?? '400');
  return lo === hi ? String(lo) : `${lo}–${hi}, variable`;
}

function FontRow({
  a,
  used,
  lost,
  locating,
  onUpdate,
  onRemove,
  onLocate
}: {
  a: AssetRecord;
  used: boolean;
  lost: boolean;
  locating: boolean;
  onUpdate: (patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => void;
  onRemove: () => void;
  onLocate: () => void;
}) {
  const uid = useId();
  const file = fontFileName(a);
  const covers = coverageText(useEditorFontFile(a.id));
  const variable = !!a.font?.weight.includes(' ');
  // Each file is named whole, since files of one family can share every other detail.
  const named = `${a.name}, ${importedName(a)}`;
  return (
    <li className="font-face" aria-label={named} data-font={a.id} data-font-file={file}>
      <div className="font-face-head">
        <span className="font-face-title">
          {[...faceParts(a, covers), formatBytes(a.bytes)].map((p, i, all) => (
            <span key={i} className={i === all.length - 1 ? 'font-face-size' : undefined}>
              {i > 0 && ' · '}
              {p}
            </span>
          ))}
        </span>
        <button className="icon-btn sm font-remove" title={used ? `Remove ${importedName(a)}: see what changes first` : `Remove ${importedName(a)}`} aria-label={`Remove ${named}`} onClick={onRemove}>
          <Trash2 />
        </button>
      </div>
      {lost ? (
        <div className="asset-note asset-missing" role="note">
          <TriangleAlert aria-hidden="true" />
          <div>
            <span>
              <b>File missing.</b> {fontFileName(a)} is no longer in the project folder, so {used ? 'text set in this font shows in another font, and the website can’t be exported' : 'this font can’t be shown'}. Locate the file it was added from to bring it back, or remove the font.
            </span>
            <div className="asset-missing-actions">
              <button className="btn btn-sm btn-primary font-locate" disabled={locating} onClick={onLocate}>
                <FileSearch /> Locate file…
              </button>
            </div>
          </div>
        </div>
      ) : (
        <FontSample a={a} />
      )}
      <span className="font-face-file">
        {importedName(a)}
      </span>
      <div className="font-face-edit">
        <div className="field">
          {variable ? (
            <>
              <span className="field-label">Weight</span>
              <span className="font-face-weight" title="A variable font covers a range of weights.">
                {weightText(a)}
              </span>
            </>
          ) : (
            <>
              <label htmlFor={`${uid}-weight`}>Weight</label>
              <select id={`${uid}-weight`} className="select sm" value={a.font?.weight ?? '400'} onChange={(e) => onUpdate({ weight: e.target.value }, `Set ${a.name} weight`)}>
                {/* A weight set by hand (450) is shown as itself, never as the nearest preset. */}
                {!WEIGHTS.some(([v]) => v === a.font?.weight) && <option value={a.font?.weight}>{a.font?.weight}</option>}
                {WEIGHTS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {v} {l}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        <div className="field">
          <label htmlFor={`${uid}-style`}>Style</label>
          <select id={`${uid}-style`} className="select sm" value={a.font?.style ?? 'normal'} onChange={(e) => onUpdate({ style: e.target.value as 'normal' | 'italic' }, `Set ${a.name} style`)}>
            <option value="normal">Upright</option>
            <option value="italic">Italic</option>
          </select>
        </div>
      </div>
    </li>
  );
}

/** Where a family is used, one line a place: site styles by name, elements by where they are, code by component. */
function describeUses(state: ProjectState, uses: FontUse[]): string[] {
  const tokens = new Map(effectiveTokens(state).map((t) => [t.id, t]));
  const lines: string[] = [];
  const elements = new Map<string, number>();
  for (const u of uses) {
    if (u.kind === 'token') {
      const t = tokens.get(u.tokenId);
      lines.push(t ? `${t.label} (${t.group === 'text' ? 'text style' : 'site style'})` : `The site style ${u.tokenId}`);
    } else if (u.kind === 'element') {
      const where =
        u.owner.kind === 'page'
          ? `the ${state.pages[u.owner.id]?.title ?? 'a'} page`
          : u.owner.kind === 'shell'
            ? `the shared ${u.owner.id}`
            : u.owner.kind === 'template'
              ? `the ${state.collections[u.owner.id]?.settings.name ?? 'collection'} layout`
              : `the ${state.components[u.owner.id]?.name ?? 'a'} component`;
      elements.set(where, (elements.get(where) ?? 0) + 1);
    } else lines.push(`The code of the ${state.components[u.componentId]?.name ?? ''} component, which names it`);
  }
  for (const [where, n] of elements) lines.push(`The font of ${plural(n, 'element', 'elements')} on ${where}`);
  return lines;
}

/**
 * What removing one file of a family the site uses does to text that keeps using the family: which remaining files
 * the browser draws it with, and what it has to fake or leave to a fallback font. `coverageOf` gives the alphabets
 * the editor has read from each file, by asset ID (null while unknown); nothing is said about letters until every
 * file involved is known.
 */
function keepEffects(a: AssetRecord, others: AssetRecord[], coverageOf: (id: string) => string[] | null): Effect[] {
  const family = a.font!.family;
  const italic = a.font!.style === 'italic';
  const kind = italic ? 'italic' : 'upright';
  const same = others.filter((o) => o.font!.style === a.font!.style);
  // The files that would draw this file's text: its own style's, or failing that, every one left.
  const drawers = same.length ? same : others;
  const files = drawers.length === 1 ? 'file' : 'files';
  const named = drawers.map(importedName).join(', ');
  const out: Effect[] = [];
  if (!same.length)
    out.push({
      warn: true,
      text: italic
        ? `Italic text in ${family} would lose its real italics: the browser would slant the upright ${files} (${named}) instead.`
        : `Text in ${family} would turn italic, ordinary paragraphs and headings included: only its italic ${files} (${named}) would be left.`
    });
  else {
    const [lo, hi] = weightRange(a.font!.weight);
    if (!same.some((o) => weightRange(o.font!.weight)[0] <= lo && weightRange(o.font!.weight)[1] >= hi))
      out.push({ warn: true, text: `${italic ? 'Italic' : 'Upright'} ${family} at ${lo === hi ? `weight ${lo}` : `weights ${lo}–${hi}`} would be drawn with the nearest weight left, or made bolder or lighter by the browser.` });
  }
  const mine = coverageOf(a.id);
  const theirs = drawers.map((o) => coverageOf(o.id));
  const known = !!mine && theirs.every(Boolean);
  const lost = known ? mine!.filter((id) => !theirs.some((t) => t!.includes(id))) : [];
  // What the author would notice most comes first: whole alphabets drawn in another font.
  if (lost.length)
    out.unshift({ warn: true, text: `${scriptLabels(lost).join(' and ')} text in ${kind} ${family} would use a fallback font: ${family}’s other ${kind} ${files} (${named}) ${drawers.length === 1 ? 'doesn’t' : 'don’t'} have those letters.` });
  // "Nothing changes" only when one file left draws every letter of this one at every one of its weights; otherwise
  // say which files take over, without a warning, since how much they differ can't be read from the files.
  const [lo, hi] = weightRange(a.font!.weight);
  const twin = known && same.find((o) => weightRange(o.font!.weight)[0] <= lo && weightRange(o.font!.weight)[1] >= hi && mine!.every((id) => coverageOf(o.id)!.includes(id)));
  if (same.length && !out.length)
    out.push({ warn: false, text: twin ? `Nothing you see changes: ${importedName(twin)} draws the same letters at the same weights.` : `${italic ? 'Italic' : 'Upright'} text in ${family} would be drawn with its other ${kind} ${files} (${named}).` });
  else if (lost.length && mine!.length > lost.length) out.push({ warn: false, text: `${scriptLabels(mine!.filter((id) => !lost.includes(id))).join(' and ')} text would be drawn with ${named} instead.` });
  else if (lost.length && drawers.length) out.push({ warn: false, text: `Other ${kind} text in ${family} doesn’t change.` });
  return out;
}

type Effect = { text: string; warn: boolean };
type Choice = 'keep' | 'fallback' | 'replace';

/**
 * Removing a file of a family the site uses: what uses the family, what changes for its text, and the author's
 * choice for those uses: keep the family on its other files, let it fall back, or put another font in its place.
 * Everything is worked out from the project as it is now, and the removal applies only to that project.
 */
function RemoveFontDialog({ a, onClose, onRemoved }: { a: AssetRecord; onClose: () => void; onRemoved: () => void }) {
  const snap = useStore((s) => s.snapshot);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [replacement, setReplacement] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const others = Object.entries(snap?.state.assets.assets ?? {})
    .filter(([k, x]) => k !== a.id && sameFontFamily(x, a))
    .map(([, x]) => x);
  const mine = useEditorFontFile(a.id);
  const shownStack = usePreviewStack();
  const coverage = useFamilyCoverage([a, ...others]);
  if (!snap) return null;
  const family = a.font!.family;
  const fontTokens = new Set(getTheme(snap.state.site.themeId).tokens.filter((t) => t.group === 'font').map((t) => t.id));
  const uses = familyUses(snap.state, family, fontTokens);
  const where = describeUses(snap.state, uses);
  const code = uses.filter((u) => u.kind === 'code').length;
  const last = !others.length;
  const effects = last ? [] : keepEffects(a, others, coverage);
  const changes = effects.filter((e) => e.warn).length;
  const covers = coverageText(mine);
  // Nothing uses the family any more (an Undo, the AI, while this was open): it simply goes.
  const unused = !uses.length;
  // A choice whose option has gone (another file of the family arrived or left while this was open) is no choice.
  const chosen = choice === 'keep' ? (last ? null : 'keep') : choice === 'fallback' ? (last ? 'fallback' : null) : choice;
  const ready = unused || chosen === 'keep' || chosen === 'fallback' || (chosen === 'replace' && !!replacement);
  const confirm = async () => {
    if (!ready || busy) return;
    setBusy(true);
    const fontUses = unused ? undefined : chosen === 'replace' ? { replaceWith: replacement } : chosen!;
    // Applies only to the project as it was shown: a change since (an Undo, the AI) asks again.
    const r = await commitOps([{ type: 'asset.remove', assetId: a.id, ...(fontUses ? { fontUses } : {}) }], `Remove ${a.name}`, undefined, snap.revision);
    setBusy(false);
    if (!r) return;
    toast(`Removed ${a.name}.`, 'info', undoAction(r));
    onClose();
    onRemoved();
  };
  const name = importedName(a);
  const usesKeep = `${others.length === 1 ? 'file' : 'files'}`;
  const missing = unused ? null : !chosen ? 'Choose an option above to remove this file.' : chosen === 'replace' && !replacement ? 'Choose a font to use instead.' : null;
  /** A choice as the app's option card: the radio and its title, then what it does, in the card. */
  const option = (value: Choice, label: string, notes: ReactNode, extra?: ReactNode) => (
    <div className="page-dialog-option font-remove-option" data-chosen={chosen === value || undefined}>
      {/* The whole card above any field it holds is the radio's target: its title and what it does. */}
      <label>
        <input type="radio" name={`${id}-choice`} value={value} checked={chosen === value} aria-labelledby={`${id}-${value}-name`} aria-describedby={`${id}-${value}-note`} onChange={() => setChoice(value)} />
        <span className="font-remove-option-text">
          <span id={`${id}-${value}-name`}>{label}</span>
          <span id={`${id}-${value}-note`} className="font-remove-option-notes">
            {notes}
          </span>
        </span>
      </label>
      {extra}
    </div>
  );
  const note = (text: string, warn?: boolean, key?: number) => (
    <span key={key} className="page-dialog-option-note" data-warn={warn || undefined}>
      {warn && <TriangleAlert aria-hidden="true" />}
      <span>{text}</span>
    </span>
  );
  return (
    <Modal
      title={`Remove ${family}’s ${faceWords(a, covers)} file?`}
      icon={
        <span className="confirm-icon" data-tone="danger" aria-hidden="true">
          <Trash2 />
        </span>
      }
      onClose={onClose}
      busy={busy}
      describedBy={`${id}-lead`}
      footer={
        <>
          {missing && (
            <p className="page-dialog-status" id={`${id}-missing`} aria-live="polite">
              {missing}
            </p>
          )}
          <button className="btn" data-autofocus onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" onClick={() => void confirm()} disabled={!ready || busy} aria-describedby={missing ? `${id}-missing` : undefined}>
            Remove file
          </button>
        </>
      }
    >
      <div className="confirm font-remove" data-testid="remove-font-dialog">
        <div className="confirm-subject">
          <span className="confirm-subject-text">
            <span className="confirm-subject-name">
              {[family, ...faceParts(a, covers)].join(' · ')}
            </span>
            <span className="confirm-subject-note">
              {name} · weight {weightText(a)}
            </span>
          </span>
        </div>
        {unused ? (
          <p className="confirm-lead" id={`${id}-lead`}>
            Nothing on your site uses {family} now, so removing this file changes nothing you see.
          </p>
        ) : (
          <>
            {where.length === 1 ? (
              <p className="confirm-lead" id={`${id}-lead`}>
                Your site uses {family} in {uses.length === 1 ? 'one place' : plural(uses.length, 'place', 'places')}: {uses.length === 1 ? where[0] : where[0].charAt(0).toLowerCase() + where[0].slice(1)}.
              </p>
            ) : (
              <>
                <p className="confirm-lead" id={`${id}-lead`}>
                  Your site uses {family} in {plural(uses.length, 'place', 'places')}:
                </p>
                <ul className="font-remove-uses">
                  {where.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </>
            )}
            <fieldset className="font-remove-choices">
              <legend>What should text in {family} use instead of this file?</legend>
              {last
                ? option('fallback', 'A fallback font', note(`This is the last ${family} file, so ${family} is taken out of every style that names it. Each draws with its next font instead, usually the system font.`, true))
                : option(
                    'keep',
                    `${family}’s other ${usesKeep}`,
                    <>
                      {note(changes ? `Styles keep ${family}, with ${changes === 1 ? 'this change' : 'these changes'}:` : `Styles keep ${family}.`)}
                      {effects.map((e, i) => note(e.text, e.warn, i))}
                    </>
                  )}
              {option(
                'replace',
                'Another font',
                note(
                  `Styles with ${family} as their first font switch to ${chosen === 'replace' && replacement ? familyName(replacement) : 'the font you choose'}. Where ${family} is only a fallback, it is taken out.${last ? '' : ` ${family}’s other ${others.length === 1 ? 'file stays' : 'files stay'} in Assets.`}`
                ),
                chosen === 'replace' && (
                  <div className="font-remove-replacement">
                    <div className="field">
                      <label htmlFor={`${id}-replacement`}>Font to use instead</label>
                      <FontSelect id={`${id}-replacement`} state={snap.state} stack={replacement} exclude={family} onChoose={(next) => setReplacement(next)} />
                    </div>
                    {/* After the field, so choosing a font never moves the select that was just used. */}
                    {replacement && (
                      <span className="font-remove-sample" style={{ fontFamily: shownStack(replacement) }} aria-hidden="true">
                        Aa
                      </span>
                    )}
                  </div>
                )
              )}
            </fieldset>
            {code > 0 && (last || chosen === 'replace') && (
              <p className="muted">
                Code that names {family} itself is not changed:{' '}
                {last ? `${code === 1 ? 'it draws' : 'they draw'} with ${code === 1 ? 'its' : 'their'} own fallback font once this last file is gone.` : `${code === 1 ? 'it keeps' : 'they keep'} using ${family}’s other files.`}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** The alphabets each of a family's files covers, by asset ID, as the editor has read them (null while unknown). */
function useFamilyCoverage(faces: AssetRecord[]): (id: string) => string[] | null {
  const files = useEditorFontFiles(faces.map((f) => f.id));
  return (id) => {
    const f = files.get(id);
    return f?.status === 'ready' && f.coverage ? f.coverage.scripts : null;
  };
}
