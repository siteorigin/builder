import { useEffect, useId, useState } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react';
import type { AssetRecord, ProjectState } from '@shared/types';
import { familyUses, sameFontFamily, type FontUse } from '@shared/fonts';
import { scriptLabels } from '@shared/font-scripts';
import { effectiveTokens } from '@generator/index';
import { getTheme } from '@catalogue/index';
import { applyOps, commitOps, toast, undoAction, useStore } from '../store';
import { DraftInput, Modal } from '../components/ui';
import { openSiteStyles } from '../lib/actions';
import { formatBytes, plural } from '../lib/storage';
import { useEditorFontFile, useEditorFontFiles, type EditorFontFile } from '../lib/editor-fonts';
import { FontSelect } from './FontSelect';

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

/** Imported web fonts: each file is one face (weight and style) of a family that Site styles can use. */
export function FontList({ fonts, usage }: { fonts: AssetRecord[]; usage: Record<string, number> }) {
  const [removing, setRemoving] = useState<string | null>(null);
  const faceOf = (a: AssetRecord) => ({ family: a.font?.family ?? a.name, weight: a.font?.weight ?? '400', style: a.font?.style ?? ('normal' as const) });
  const update = (a: AssetRecord, patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => void applyOps([{ type: 'asset.update', assetId: a.id, font: { ...faceOf(a), ...patch } }], label);
  /** A family is renamed as a whole, so its files stay together and the styles using it follow. */
  const renameFamily = (a: AssetRecord, family: string) =>
    void applyOps(
      fonts.filter((x) => sameFontFamily(x, a)).map((x) => ({ type: 'asset.update' as const, assetId: x.id, font: { ...faceOf(x), family } })),
      `Rename font family to ${family}`
    );
  /** After a file goes, focus moves to the next font's Remove (when it can be used), else to Add fonts, never to the page. */
  const focusAfter = (a: AssetRecord) => {
    const i = fonts.findIndex((x) => x.id === a.id);
    const next = i < 0 ? undefined : (fonts[i + 1] ?? fonts[i - 1]);
    requestAnimationFrame(() => ((next && document.querySelector<HTMLElement>(`[data-font="${next.id}"] .font-remove:not(:disabled)`)) || document.querySelector<HTMLElement>('.asset-add'))?.focus());
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
      <ul>
        {fonts.map((a) => (
          <FontRow key={a.id} a={a} used={!!usage[a.id]} onRename={(family) => renameFamily(a, family)} onUpdate={(patch, label) => update(a, patch, label)} onRemove={() => void remove(a)} />
        ))}
      </ul>
      {asking && <RemoveFontDialog a={asking} onClose={() => setRemoving(null)} onRemoved={() => focusAfter(asking)} />}
    </section>
  );
}

function FontRow({ a, used, onRename, onUpdate, onRemove }: { a: AssetRecord; used: boolean; onRename: (family: string) => void; onUpdate: (patch: Partial<NonNullable<AssetRecord['font']>>, label: string) => void; onRemove: () => void }) {
  const file = fontFileName(a);
  const covers = coverageText(useEditorFontFile(a.id));
  const variable = !!a.font?.weight.includes(' ');
  // Each file is named whole, since files of one family can share every other detail.
  const named = `${a.name}, ${importedName(a)}`;
  return (
    <li className="font-face" aria-label={named} data-font={a.id} data-font-file={file}>
      <div className="font-face-head">
        <b title={a.name}>{a.font?.family ?? a.name}</b>
        <span className="font-face-meta">
          {[faceLabel(a), covers, formatBytes(a.bytes), used ? 'Family in use' : 'Not used'].filter(Boolean).join(' · ')}
        </span>
        <span className="font-face-file" title={a.file}>
          {importedName(a)}
        </span>
      </div>
      <FontSample a={a} />
      <div className="font-face-edit">
        <span className="font-face-label" aria-hidden="true">
          Family name, shared by its files
        </span>
        <DraftInput
          className="input sm"
          value={a.font?.family ?? ''}
          ariaLabel={`Font family name for ${named}`}
          onCommit={(v) => {
            const family = v.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 60);
            if (!family) return false;
            if (family !== a.font?.family) onRename(family);
          }}
        />
        <select className="select sm" value={variable ? a.font!.weight : a.font?.weight ?? '400'} disabled={variable} aria-label={`Weight of ${named}`} title={variable ? 'A variable font covers a range of weights.' : undefined} onChange={(e) => onUpdate({ weight: e.target.value }, `Set ${a.name} weight`)}>
          {variable && <option value={a.font!.weight}>Variable</option>}
          {WEIGHTS.map(([v, l]) => (
            <option key={v} value={v}>
              {v} {l}
            </option>
          ))}
        </select>
        <select className="select sm" value={a.font?.style ?? 'normal'} aria-label={`Style of ${named}`} onChange={(e) => onUpdate({ style: e.target.value as 'normal' | 'italic' }, `Set ${a.name} style`)}>
          <option value="normal">Upright</option>
          <option value="italic">Italic</option>
        </select>
        <button className="btn btn-sm btn-ghost font-remove" title={used ? `Remove ${a.name}: see what changes first` : `Remove ${a.name}`} aria-label={`Remove ${named}`} onClick={onRemove}>
          <Trash2 />
        </button>
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
        u.owner.kind === 'page' ? `the ${state.pages[u.owner.id]?.title ?? 'a'} page` : u.owner.kind === 'shell' ? `the shared ${u.owner.id}` : `the ${state.components[u.owner.id]?.name ?? 'a'} component`;
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
function keepEffects(a: AssetRecord, others: AssetRecord[], coverageOf: (id: string) => string[] | null): string[] {
  const family = a.font!.family;
  const italic = a.font!.style === 'italic';
  const kind = italic ? 'italic' : 'upright';
  const same = others.filter((o) => o.font!.style === a.font!.style);
  // The files that would draw this file's text: its own style's, or failing that, every one left.
  const drawers = same.length ? same : others;
  const named = drawers.map(importedName).join(', ');
  const out: string[] = [];
  if (!same.length)
    out.push(
      italic
        ? `Italic text in ${family} would be slanted by the browser from its upright ${others.length === 1 ? 'file' : 'files'} (${named}), not drawn with real italics.`
        : `Upright text in ${family} would be drawn with its italic ${others.length === 1 ? 'file' : 'files'} (${named}): ordinary paragraphs and headings set in it would turn italic.`
    );
  else {
    out.push(`${italic ? 'Italic' : 'Upright'} text in ${family} would be drawn with its other ${kind} ${same.length === 1 ? 'file' : 'files'} (${named}), which may differ from this one.`);
    const [lo, hi] = weightRange(a.font!.weight);
    if (!same.some((o) => weightRange(o.font!.weight)[0] <= lo && weightRange(o.font!.weight)[1] >= hi))
      out.push(`At ${lo === hi ? `weight ${lo}` : `weights ${lo}–${hi}`} it would be drawn with the nearest weight left, or made bolder or lighter by the browser.`);
  }
  const mine = coverageOf(a.id);
  const theirs = drawers.map((o) => coverageOf(o.id));
  if (mine && theirs.every(Boolean)) {
    const lost = mine.filter((id) => !theirs.some((t) => t!.includes(id)));
    if (lost.length) out.push(`${scriptLabels(lost).join(' and ')} letters in ${kind} ${family} would be drawn with a fallback font: ${drawers.length === 1 ? 'that file doesn’t' : 'those files don’t'} have them.`);
  }
  return out;
}

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
  const coverage = useFamilyCoverage([a, ...others]);
  if (!snap) return null;
  const family = a.font!.family;
  const fontTokens = new Set(getTheme(snap.state.site.themeId).tokens.filter((t) => t.group === 'font').map((t) => t.id));
  const uses = familyUses(snap.state, family, fontTokens);
  const where = describeUses(snap.state, uses);
  const code = uses.filter((u) => u.kind === 'code').length;
  const last = !others.length;
  const effects = last ? [`Text set in ${family} would be drawn with the next font of each style that names it, such as the system font.`] : keepEffects(a, others, coverage);
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
  const option = (value: Choice, label: string, hint: string) => (
    <label className="font-remove-choice">
      <input type="radio" name={`${id}-choice`} value={value} checked={chosen === value} onChange={() => setChoice(value)} />
      <span>
        <span className="font-remove-choice-label">{label}</span>
        <span className="field-hint">{hint}</span>
      </span>
    </label>
  );
  return (
    <Modal
      title={`Remove ${a.name}?`}
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
          <button className="btn" data-autofocus onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger-fill" onClick={() => void confirm()} disabled={!ready || busy}>
            Remove file
          </button>
        </>
      }
    >
      <div className="confirm font-remove" data-testid="remove-font-dialog">
        <div className="confirm-subject">
          <span className="confirm-subject-text">
            <span className="confirm-subject-name">
              {family} · {faceLabel(a)}
              {covers ? ` · ${covers}` : ''}
            </span>
            <span className="confirm-subject-note">{fontFileName(a)}</span>
          </span>
        </div>
        {unused ? (
          <p className="confirm-lead" id={`${id}-lead`}>
            Nothing on your site uses {family} now, so removing this file changes nothing you see.
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
            <ul className="confirm-details">
              {effects.map((e, i) => (
                <li key={i} data-kind="risk">
                  <TriangleAlert />
                  <span>{e}</span>
                </li>
              ))}
            </ul>
            <div className="font-remove-choices" role="radiogroup" aria-label={`What ${family} uses get instead`}>
              {last
                ? option('fallback', 'Let them fall back', `Every style that names ${family} draws with its next font instead.`)
                : option('keep', `Keep using ${family}’s other ${others.length === 1 ? 'file' : 'files'}`, `Styles keep ${family}; its text is drawn as described above.`)}
              {option('replace', 'Use another font instead', `Styles that lead with ${family} switch to the font you choose; where it is only a backup font, it is taken out.${last ? '' : ' Its other files stay in Assets.'}`)}
              {chosen === 'replace' && (
                <div className="font-remove-replacement">
                  <FontSelect state={snap.state} stack={replacement} exclude={family} label="Font to use instead" onChoose={(next) => setReplacement(next)} />
                </div>
              )}
            </div>
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
