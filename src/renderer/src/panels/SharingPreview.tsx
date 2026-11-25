import { useState, type CSSProperties } from 'react';
import { Image as ImageIcon, ImageOff } from 'lucide-react';
import { useStore } from '../store';
import { AssetImage } from '../components/AssetImage';
import { openSection, Segmented } from '../components/ui';
import { openSiteStyles } from '../lib/actions';
import type { LinkCard } from '../lib/seo-preview';
import { SHARE_PLATFORMS, shareCardLayout, type ShareImageBox, type SharePlatform } from '../lib/share-card-layout';
import { missingKey } from './ImagesPicker';

/** Site details, with the cursor on the site's sharing image (the one a page without an image of its own follows) or its public URL. */
export function openSiteSharing(field: 'socialImage' | 'baseUrl') {
  openSiteStyles();
  openSection('site-settings', { focus: field === 'baseUrl' ? '#site-public-url' : '.insp-image.plain-social .insp-image-top .btn' });
}

/** A length of the card at full size, which shrinks with the card where there is less room (see SeoPreview.css). */
const px = (n: number) => `calc(var(--u) * ${n})`;

/** The picture in its slot, cropped or whole as the platform shows it; an icon where it can't be shown (yet). */
function CardPicture({ picture, box, devUrl }: { picture: LinkCard['image']; box: ShareImageBox; devUrl: string | null }) {
  const [failed, setFailed] = useState(false);
  const show = picture && devUrl && !failed;
  // A picture whose own height isn't known takes its own shape, up to the platform's bounds.
  const natural = !!show && box.height === null;
  const style: CSSProperties = box.height === null ? { width: px(box.width), ...(show ? {} : { aspectRatio: '1.91' }) } : { width: px(box.width), aspectRatio: `${box.width} / ${box.height}` };
  return (
    <span className={`share-card-image ${box.at} ${box.fit}${natural ? ' natural' : ''}${picture ? '' : ' empty'}`} style={style}>
      {show ? (
        <AssetImage asset={picture} devUrl={devUrl} cover={!natural} alt="" style={natural ? { maxHeight: px(box.maxHeight) } : undefined} onError={() => setFailed(true)} />
      ) : picture ? (
        <ImageOff aria-hidden="true" />
      ) : (
        <ImageIcon aria-hidden="true" />
      )}
    </span>
  );
}

/** One platform's card, with what that platform does with this picture said under it. */
function PlatformCard({ platform, card, labelled }: { platform: (typeof SHARE_PLATFORMS)[number]; card: LinkCard; labelled: boolean }) {
  const runtime = useStore((s) => s.runtime);
  const snapshot = useStore((s) => s.snapshot);
  const devUrl = runtime.state === 'ready' ? runtime.url : null;
  const picture = card.image;
  const layout = shareCardLayout(platform.id, picture ?? null);
  const box = layout.image;
  const image = box && (
    // A repaired or replaced file, or a restarted preview, gets another try.
    <CardPicture key={picture ? `${picture.id}\n${picture.file}\n${devUrl}\n${missingKey(snapshot, picture.id)}` : 'none'} picture={picture} box={box} devUrl={devUrl} />
  );
  const lang = card.language || undefined;
  const host = <span className="share-card-host">{card.host ?? 'No usable public URL'}</span>;
  const title = (
    <span className="share-card-title" lang={lang} dir="auto">
      {card.title}
    </span>
  );
  const description = layout.descriptionLines > 0 && (
    <span className={`share-card-desc${card.description ? '' : ' none'}`} lang={card.description ? lang : undefined} dir="auto">
      {card.description || 'No description'}
    </span>
  );
  const style = { '--w': layout.width, '--title-lines': layout.titleLines, '--desc-lines': layout.descriptionLines } as CSSProperties;
  return (
    <div className="share-sample" role="group" aria-label={`${platform.name} link preview`}>
      {labelled && (
        <p className="share-sample-name">
          {platform.place} · {platform.name}
        </p>
      )}
      <div className="share-card-fit">
        <div className={`share-card share-card-${platform.id}${layout.overlay ? ' overlay' : ''}`} data-platform={platform.id} style={style}>
          {layout.overlay ? (
            <>
              <span className="share-card-frame">
                {image}
                {title}
              </span>
              <span className="share-card-from">
                {card.host && 'From'}
                {host}
              </span>
            </>
          ) : (
            <span className={`share-card-frame${box?.at === 'side' ? ' beside' : ''}`}>
              {box?.at !== 'below' && image}
              <span className="share-card-text">
                {layout.host === 'above' && host}
                {title}
                {description}
                {layout.host === 'below' && host}
              </span>
              {box?.at === 'below' && image}
            </span>
          )}
        </div>
      </div>
      {layout.note && <p className="field-hint share-sample-note">{layout.note}</p>}
    </div>
  );
}

/**
 * A page or a post as a shared link shows it where people share links: the effective image, title, description and
 * host, whichever of the document and the site each comes from, laid out as each platform lays a card out (see
 * lib/share-card-layout). It reads what the generator writes into the document's `<head>` (see lib/seo-preview
 * `previewDocument`). With `all`, every platform shows; otherwise one at a time, as chosen.
 */
export function SharingPreview({ card, all = false }: { card: LinkCard; all?: boolean }) {
  const snapshot = useStore((s) => s.snapshot);
  const [chosen, setChosen] = useState<SharePlatform>('feed');
  const gone = !!card.image && !!snapshot?.missingAssets.some((m) => m.assetId === card.image!.id && m.original);
  const shown = all ? SHARE_PLATFORMS : SHARE_PLATFORMS.filter((p) => p.id === chosen);
  return (
    <div className="share-preview">
      {!all && <Segmented<SharePlatform> full radio label="Platform" value={chosen} onChange={setChosen} options={SHARE_PLATFORMS.map((p) => ({ value: p.id, label: p.name }))} />}
      <p className="field-hint share-preview-image">
        {card.imageSaid}
        {gone && ' Its file is missing from the project.'}
      </p>
      {shown.map((p) => (
        <PlatformCard key={p.id} platform={p} card={card} labelled={all} />
      ))}
      <p className="field-hint share-preview-note">How each platform likely crops the picture and cuts the text short. Their apps change, and differ between devices.</p>
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
