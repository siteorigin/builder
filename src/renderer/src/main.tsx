import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { registerPacks } from '@catalogue/index';
import { api, setState } from './store';

const root = createRoot(document.getElementById('root')!);
// The theme packs main loaded at startup are registered before anything reads the catalogue.
api.app
  .catalogue()
  .then((catalogue) => {
    registerPacks(catalogue.packs);
    setState({ packs: { refused: catalogue.refused, userDir: catalogue.userDir } });
    root.render(<App />);
  })
  .catch((e: Error) => {
    root.render(<p className="fatal">SiteOrigin Builder could not load its themes: {e.message}</p>);
  });
