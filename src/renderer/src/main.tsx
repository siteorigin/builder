// First: while timing marks are on it installs the hook React DOM finds as it loads, to count commits (lib/perf.ts).
import './lib/perf';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App, abandonLeaves } from './App';
import { registerPacks } from '@catalogue/index';
import { api, setState } from './store';
import { followAppearance } from './lib/appearance';
import { RenderFailure } from './components/RenderFailure';

// For the app's lifetime: the editor follows its Appearance from before anything renders.
followAppearance();
const root = createRoot(document.getElementById('root')!);
// The theme packs main loaded at startup are registered before anything reads the catalogue.
api.app
  .catalogue()
  .then((catalogue) => {
    // Without any theme there is nothing to make or open a site with: say why, rather than fail part way in.
    if (!catalogue.packs.length) {
      root.render(
        <div className="fatal">
          <p>SiteOrigin Builder could not load any themes, so it cannot open or create a site. Reinstalling it puts the built-in theme back.</p>
          <ul>
            {catalogue.refused.map((r) => (
              <li key={r.dir}>{r.reason}</li>
            ))}
          </ul>
        </div>
      );
      return;
    }
    registerPacks(catalogue.packs);
    setState({ packs: { refused: catalogue.refused, userDir: catalogue.userDir } });
    // Anything else that fails while rendering (a notice, a dialog host) still leaves a way back.
    root.render(
      <RenderFailure onFailure={abandonLeaves}>
        <App />
      </RenderFailure>
    );
  })
  .catch((e: Error) => {
    root.render(<p className="fatal">SiteOrigin Builder could not load its themes: {e.message}</p>);
  });
