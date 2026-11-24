import type { ProjectState } from '@shared/types';
import { importedFontStack, projectFontFamilies } from '@shared/fonts';
import { fontFamilies, installedFonts } from '@catalogue/fonts';
import { api, getState, toast } from '../store';

/** The font menu's "Import a font…" entry; never saved as a value. */
const IMPORT_FONT = '__import-font';
/** The entry shown while a font follows another; choosing a font gives it its own. */
const FOLLOWING = '__following';
/** Fonts that need no download; the project's installed web fonts are listed above them. */
const SYSTEM_FONT_CHOICES = [
  { label: 'System sans-serif', value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Georgia (serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Helvetica / Arial', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Monospace', value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }
];

/** The first family in a font stack, as a person would name it ("Fraunces", not "'Fraunces Variable'"). */
export const familyName = (stack: string) => (stack.split(',')[0] ?? '').replace(/['"]/g, '').replace(/\s+Variable$/i, '').trim() || stack;

/**
 * A font chosen by name: the project's imported fonts, the installed web fonts and system fonts, and a way
 * to import one. A stack that matches none (typed by hand, or written by the assistant) shows as itself,
 * and a font that follows another shows what it follows until a font is chosen.
 */
export function FontSelect({
  id,
  state,
  stack,
  follows,
  label,
  exclude,
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
  onChoose: (stack: string) => unknown;
}) {
  const imported = projectFontFamilies(state)
    .filter((f) => f.family.toLowerCase() !== exclude?.toLowerCase())
    .map((f) => ({ label: f.family, value: importedFontStack(f.family) }));
  const builtIn = [...installedFonts(state).map((f) => ({ label: `${f.name} (${f.category})`, value: f.stack })), ...SYSTEM_FONT_CHOICES];
  const all = [...imported, ...builtIn];
  // An equivalent stack (same first family) shows as that font; the stored value stays until a new choice.
  const primary = fontFamilies(stack)[0]?.toLowerCase();
  const selected = all.find((f) => f.value === stack) ?? all.find((f) => fontFamilies(f.value)[0]?.toLowerCase() === primary);
  /** Bring in a web font and use it straight away. */
  const importFont = async () => {
    const r = await api.project.importAssets(undefined, 'font').catch((e: Error) => ({ ok: false, assetIds: [] as string[], message: `The font couldn’t be added: ${e.message}` }));
    if (r.message) toast(r.message, r.assetIds.length ? 'info' : 'error');
    const doc = getState().snapshot?.state.assets.assets ?? {};
    const font = r.assetIds.map((a) => doc[a]).find((a) => a?.kind === 'font' && a.font);
    if (font?.font) onChoose(importedFontStack(font.font.family));
    else if (r.assetIds.length) toast('That file is not a font. Choose a WOFF2 or WOFF file.', 'error');
  };
  return (
    <select
      id={id}
      className="select sm"
      aria-label={label}
      value={follows ? FOLLOWING : (selected?.value ?? '')}
      onChange={(e) => {
        const v = e.target.value;
        if (v === IMPORT_FONT) void importFont();
        else if (v && v !== FOLLOWING) onChoose(v);
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
      <option value={IMPORT_FONT}>Import a font…</option>
    </select>
  );
}
