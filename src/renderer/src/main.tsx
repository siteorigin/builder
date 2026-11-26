// First: while timing marks are on it installs the hook React DOM finds as it loads, to count commits (lib/perf.ts).
import { perfMark } from './lib/perf';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App, abandonLeaves } from './App';
import { registerPacks } from '@catalogue/index';
import { api, setState } from './store';
import { followAppearance } from './lib/appearance';
import { RenderFailure } from './components/RenderFailure';
import { CatalogueFailed, NoThemes } from './components/StartupFailure';

// Every module the editor's script imports up front has been evaluated (src/shared/perf.ts).
perfMark('launch.scriptEvaluated');

// For the app's lifetime: the editor follows its Appearance from before anything renders.
followAppearance();
const root = createRoot(document.getElementById('root')!);
// Welcome needs no theme, so it shows while the main process verifies the theme packs. The catalogue is registered
// before anything reads it: a project opens only once the packs are verified, and the editor waits for it (App.tsx).
// Anything else that fails while rendering (a notice, a dialog host) still leaves a way back.
root.render(
  <RenderFailure onFailure={abandonLeaves}>
    <App />
  </RenderFailure>
);
api.app
  .catalogue()
  .then((catalogue) => {
    // Without any theme there is nothing to make or open a site with: say why, rather than fail part way in.
    if (!catalogue.packs.length) {
      root.render(<NoThemes refused={catalogue.refused} userDir={catalogue.userDir} />);
      return;
    }
    registerPacks(catalogue.packs);
    setState({ packs: { ready: true, refused: catalogue.refused, userDir: catalogue.userDir } });
    perfMark('launch.catalogueReceived');
  })
  .catch((e: Error) => {
    root.render(<CatalogueFailed message={e.message} />);
  });
