import { useId } from 'react';
import type { FontCategory, ProjectState } from '@shared/types';
import { FAMILY_KEYWORDS, importedFontStack, isFontCategory, projectFontFamilies, projectFontStack, stackFallback, withFallback } from '@shared/fonts';
import { fontFamilies, installedFonts } from '@catalogue/fonts';
import { Upload } from 'lucide-react';
import { api, getState, toast } from '../store';

/** The entry shown while a font follows another; choosing a font gives it its own. */
const FOLLOWING = '__following';
/** Fonts that need no download; the project's installed web fonts are listed above them. */
const SYSTEM_FONT_CHOICES = [
  { label: 'System sans-serif', value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Georgia (serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Helvetica / Arial', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Monospace', value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }
];

/** The fallbacks an imported font whose files do not say what kind of face it is can end in. */
const FALLBACK_CHOICES: ReadonlyArray<{ label: string; value: FontCategory }> = [
  { label: 'Sans-serif', value: 'sans-serif' },
  { label: 'Serif', value: 'serif' },
  { label: 'Monospace', value: 'monospace' }
];

/** The first family in a font stack, as a person would name it ("Fraunces", not "'Fraunces Variable'"). */
export const familyName = (stack: string) => (stack.split(',')[0] ?? '').replace(/['"]/g, '').replace(/\s+Variable$/i, '').trim() || stack;

/**
 * A font chosen by name: the project's imported fonts, the installed web fonts and system fonts. A stack that
 * matches none (typed by hand, or written by the assistant) shows as itself, and a font that follows another
 * shows what it follows until a font is chosen. With `importable`, a button beside it adds a font file and
 * chooses it: adding one is an action of its own, never an entry in the list.
 */
export function FontSelect({
  id,
  state,
  stack,
  follows,
  label,
  exclude,
  importable,
  onChoose
}: {
  id?: string;
  state: ProjectState;
  /** The stack in effect, a followed font already resolved. */
  stack: string;
  /** The label of the font this one follows, when it follows one. */
  follows?: string | null;
  /** An accessible name, when no <label> points at `id`. */
  label?: string;
  /** An imported family to leave out (one being removed). */
  exclude?: string;
  /** Offer "Add a font file" beside the list, choosing the added font here; the button is named for this (as "Add a font file for {importable}"). */
  importable?: string;
  onChoose: (stack: string) => unknown;
}) {
  const imported = projectFontFamilies(state)
    .filter((f) => f.family.toLowerCase() !== exclude?.toLowerCase())
    .map((f) => ({ label: f.family, value: importedFontStack(f.family, f.category), unknownKind: !f.category }));
  // A family being removed is left out wherever it leads a stack, built-in choices included ("Georgia (serif)" for an imported Georgia).
  const leads = (value: string) => fontFamilies(value)[0]?.toLowerCase() === exclude?.toLowerCase();
  const builtIn = [...installedFonts(state).map((f) => ({ label: `${f.name} (${f.category})`, value: f.stack })), ...SYSTEM_FONT_CHOICES].filter((f) => !exclude || !leads(f.value));
  const all = [...imported, ...builtIn];
  // An equivalent stack (same first family) shows as that font; the stored value stays until a new choice.
  const primary = fontFamilies(stack)[0]?.toLowerCase();
  const selected = all.find((f) => f.value === stack) ?? all.find((f) => fontFamilies(f.value)[0]?.toLowerCase() === primary);
  const fallbackId = `${useId()}-fallback`;
  // An imported font whose files do not say what kind of face it is: the author says which fallback it ends in (#1490).
  // A bare keyword ("serif") is no font, even beside an imported family of that name.
  const askFallback = !follows && !!selected && 'unknownKind' in selected && selected.unknownKind && !FAMILY_KEYWORDS.has(stack.split(',')[0].trim().toLowerCase());
  const fallback = askFallback ? stackFallback(stack) : undefined;
  /** Bring in a web font and use it straight away. */
  const importFont = async () => {
    const r: { ok: boolean; assetIds: string[]; message?: string; note?: string } = await api.project.importAssets(undefined, 'font').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The font couldn’t be added: ${e.message}` }));
    const said = [r.note, r.message].filter(Boolean).join(' ');
    if (said) toast(said, r.message && !r.assetIds.length ? 'error' : 'info');
    const doc = getState().snapshot?.state.assets.assets ?? {};
    const font = r.assetIds.map((a) => doc[a]).find((a) => a?.kind === 'font' && a.font);
    // Its family as the project has it now, with any files it joined, so its fallback is the family's kind.
    const now = getState().snapshot?.state;
    if (font?.font) onChoose(now ? projectFontStack(now, font.font.family) : importedFontStack(font.font.family, font.font.category));
    else if (r.assetIds.length) toast('That file is not a font. Choose a WOFF2 or WOFF file.', 'error');
  };
  const select = (
    <select
      id={id}
      className="select sm"
      aria-label={label}
      value={follows ? FOLLOWING : (selected?.value ?? '')}
      onChange={(e) => {
        const v = e.target.value;
        if (v && v !== FOLLOWING) onChoose(v);
      }}
    >
      {follows ? <option value={FOLLOWING}>Same as {follows}</option> : !selected && <option value="">{stack ? `Custom: ${familyName(stack)}` : 'Choose a font…'}</option>}
      {imported.length > 0 && (
        <optgroup label="Imported fonts">
          {imported.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label="Built-in fonts">
        {builtIn.map((f) => (
          <option key={f.label} value={f.value}>
            {f.label}
          </option>
        ))}
      </optgroup>
    </select>
  );
  const control = importable ? (
    <div className="font-select">
      {select}
      <button type="button" className="icon-btn sm" title="Add a font file and use it here" aria-label={`Add a font file for ${importable}`} onClick={() => void importFont()}>
        <Upload />
      </button>
    </div>
  ) : (
    select
  );
  // The same wrapper either way, so the font select keeps focus when the fallback row comes or goes.
  return (
    <div className="font-select-group">
      {control}
      {askFallback && (
        <div className="font-select-fallback">
          <label htmlFor={fallbackId}>Fallback</label>
          <select
            id={fallbackId}
            className="select sm"
            title="Shown while the font loads, and for any character its file lacks"
            value={fallback ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (isFontCategory(v)) onChoose(withFallback(stack, v));
            }}
          >
            {!fallback && <option value="">{fallback === null ? 'Custom fallback' : 'None'}</option>}
            {FALLBACK_CHOICES.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
