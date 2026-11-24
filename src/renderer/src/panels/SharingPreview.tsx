import { Image as ImageIcon, ImageOff } from 'lucide-react';
import type { PageDoc, ProjectState } from '@shared/types';
import { pageSharing } from '@shared/sharing';
import { useStore } from '../store';
import { AssetImage } from '../components/AssetImage';
import { openSection } from '../components/ui';
import { openSiteStyles } from '../lib/actions';
import { sharingView } from '../lib/sharing';
import { missingKey } from './ImagesPicker';

/** Site details, with the cursor on the site's sharing image (the one a page without an image of its own follows) or its public URL. */
export function openSiteSharing(field: 'socialImage' | 'baseUrl') {
  openSiteStyles();
  openSection('site-settings', { focus: field === 'baseUrl' ? '#site-public-url' : '[data-site-field="socialImage"]' });
}

/**
 * A page as a shared link shows it: the effective image, title and description together, whichever of the page
 * and the site each comes from. It reads what the generator writes into the page's `<head>`.
 */
export function SharingPreview({ state, page }: { state: ProjectState; page: PageDoc }) {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const view = sharingView(state, page);
  const image = pageSharing(state, page).image;
  const picture = image?.kind === 'image' ? image : undefined;
  return (
    <div className="share-preview">
      <div className="share-card" role="group" aria-label="Link preview">
        <div className={`share-card-image${picture ? '' : ' empty'}`}>
          {picture && devUrl ? <AssetImage key={missingKey(snapshot, picture.id)} asset={picture} devUrl={devUrl} cover alt="" /> : picture ? <ImageOff aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          {!picture && <span>No sharing image</span>}
        </div>
        <div className="share-card-text">
          <span className="share-card-host">{view.host ?? 'No usable public URL'}</span>
          <span className="share-card-title">{view.title}</span>
          <span className={`share-card-desc${view.description ? '' : ' none'}`}>{view.description || 'No description'}</span>
        </div>
        <span className="sr-only">
          {picture ? `Image: ${view.imageName ?? picture.name}, ${view.imageSource === 'page' ? 'this page’s own' : 'the site’s'}.` : 'No sharing image.'}
        </span>
      </div>
      {view.addressNote && (
        <p className="field-hint share-preview-note">
          {view.addressNote}{' '}
          <button type="button" className="link-btn" onClick={() => openSiteSharing('baseUrl')}>
            Open Site details
          </button>
        </p>
      )}
    </div>
  );
}
