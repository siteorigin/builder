import { Image as ImageIcon, ImageOff } from 'lucide-react';
import { useStore } from '../store';
import { AssetImage } from '../components/AssetImage';
import { openSection } from '../components/ui';
import { openSiteStyles } from '../lib/actions';
import type { LinkCard } from '../lib/seo-preview';
import { missingKey } from './ImagesPicker';

/** Site details, with the cursor on the site's sharing image (the one a page without an image of its own follows) or its public URL. */
export function openSiteSharing(field: 'socialImage' | 'baseUrl') {
  openSiteStyles();
  openSection('site-settings', { focus: field === 'baseUrl' ? '#site-public-url' : '.insp-image.plain-social .insp-image-top .btn' });
}

/**
 * A page or a post as a shared link shows it: the effective image, title and description together, whichever of the
 * document and the site each comes from. It reads what the generator writes into the document's `<head>` (see
 * lib/seo-preview `previewDocument`).
 */
export function SharingPreview({ card }: { card: LinkCard }) {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const picture = card.image;
  return (
    <div className="share-preview">
      <div className="share-card" role="group" aria-label="Link preview">
        <div className={`share-card-image${picture ? '' : ' empty'}`}>
          {picture && devUrl ? <AssetImage key={missingKey(snapshot, picture.id)} asset={picture} devUrl={devUrl} cover alt="" /> : picture ? <ImageOff aria-hidden="true" /> : <ImageIcon aria-hidden="true" />}
          {!picture && <span>No sharing image</span>}
        </div>
        <div className="share-card-text">
          <span className="share-card-host">{card.host ?? 'No usable public URL'}</span>
          <span className="share-card-title">{card.title}</span>
          <span className={`share-card-desc${card.description ? '' : ' none'}`}>{card.description || 'No description'}</span>
        </div>
        <span className="sr-only">{card.imageSaid}</span>
      </div>
      {card.addressNote && (
        <p className="field-hint share-preview-note">
          {card.addressNote}{' '}
          <button type="button" className="link-btn" onClick={() => openSiteSharing('baseUrl')}>
            Open Site details
          </button>
        </p>
      )}
    </div>
  );
}
