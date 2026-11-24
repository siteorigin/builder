import { useSyncExternalStore } from 'react';
import type { AppSettings, Appearance } from '@shared/api';
import { editorScheme, knownAppearance } from '@shared/appearance';
import { api } from '../store';

/**
 * Keep the editor drawn in its Appearance: when Settings saves a new one (from the dialog or through the API), and,
 * on System, when this computer's setting changes. The preload marks the first paint; this takes over from it. The
 * website preview never follows it (see the iframe rule in styles.css).
 */
/** Draws the editor in a saved Appearance at once; set while followAppearance runs. */
let show: ((a: Appearance) => void) | null = null;

export function followAppearance(): () => void {
  const system = window.matchMedia('(prefers-color-scheme: dark)');
  let chosen: Appearance | null = null;
  // Until the saved Appearance is known, the preload's mark stands.
  const apply = () => {
    if (chosen) document.documentElement.dataset.appearance = editorScheme(chosen, system.matches);
  };
  const choose = (a: Appearance) => {
    chosen = knownAppearance(a);
    apply();
  };
  show = choose;
  const off = api.on('appearance', choose);
  system.addEventListener('change', apply);
  // The saved Appearance, unless Settings has already said a newer one.
  void api.app
    .getSettings()
    .then((s) => chosen ?? choose(s.appearance))
    .catch(() => undefined);
  return () => {
    if (show === choose) show = null;
    off();
    system.removeEventListener('change', apply);
  };
}

/** The scheme the editor is drawn in right now, from its root's mark (the preload's, then followAppearance's). */
const drawnScheme = (): 'light' | 'dark' => (document.documentElement.dataset.appearance === 'dark' ? 'dark' : 'light');
const watchDrawnScheme = (changed: () => void) => {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-appearance'] });
  return () => watch.disconnect();
};
/** The scheme the editor is drawn in, kept current: System resolved to this computer's setting, as it changes too. */
export const useEditorScheme = () => useSyncExternalStore(watchDrawnScheme, drawnScheme);

let switching = false;
/**
 * Saves the scheme the editor is not drawn in as its Appearance (Light or Dark, never System), and draws the editor
 * in what was saved as soon as the save answers: main tells the editor only when the saved Appearance changed, so an
 * event merged with another save's, or late, must not leave it drawn in the old one. One switch at a time, for the
 * whole editor: a second press before the first has answered would see the old scheme and save the same one again.
 * Resolves to the saved settings, or null when a switch was already on its way.
 */
export async function switchScheme(): Promise<AppSettings | null> {
  if (switching) return null;
  switching = true;
  try {
    const saved = await api.app.setSettings({ appearance: drawnScheme() === 'dark' ? 'light' : 'dark' });
    show?.(saved.appearance);
    return saved;
  } finally {
    switching = false;
  }
}
