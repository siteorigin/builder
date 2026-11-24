import type { Appearance } from '@shared/api';
import { editorScheme, knownAppearance } from '@shared/appearance';
import { api } from '../store';

/**
 * Keep the editor drawn in its Appearance: when Settings saves a new one (from the dialog or through the API), and,
 * on System, when this computer's setting changes. The preload marks the first paint; this takes over from it. The
 * website preview never follows it (see the iframe rule in styles.css).
 */
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
  const off = api.on('appearance', choose);
  system.addEventListener('change', apply);
  // The saved Appearance, unless Settings has already said a newer one.
  void api.app
    .getSettings()
    .then((s) => chosen ?? choose(s.appearance))
    .catch(() => undefined);
  return () => {
    off();
    system.removeEventListener('change', apply);
  };
}
