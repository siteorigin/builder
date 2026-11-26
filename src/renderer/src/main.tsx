// First: while timing marks are on it installs the hook React DOM finds as it loads, to count commits (lib/perf.ts).
import './lib/perf';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App, abandonLeaves } from './App';
import { registerPacks } from '@catalogue/index';
import { api, setState } from './store';
import { followAppearance } from './lib/appearance';
import { RenderFailure } from './components/RenderFailure';
import { CatalogueFailed, NoThemes } from './components/StartupFailure';

// For the app's lifetime: the editor follows its Appearance from before anything renders.
followAppearance();
const root = createRoot(document.getElementById('root')!);
// The theme packs main loaded at startup are registered before anything reads the catalogue.
api.app
  .catalogue()
  .then((catalogue) => {
    // Without any theme there is nothing to make or open a site with: say why, rather than fail part way in.
    if (!catalogue.packs.length) {
      root.render(<NoThemes refused={catalogue.refused} userDir={catalogue.userDir} />);
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
    root.render(<CatalogueFailed message={e.message} />);
  });
