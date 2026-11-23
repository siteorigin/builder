import { useMemo, useState } from 'react';
import { Check, Expand, X } from 'lucide-react';
import type { ChatImageRef } from '@shared/api';
import type { AssetRecord } from '@shared/types';
import { useStore } from '../store';
import { imageLabels } from '../lib/chatQuestions';
import { Picture, Thumb } from './AssetPicture';
import { Modal } from './ui';

/** The local preview server the pictures load from, or null until the site preview is running. */
export function useDevUrl(): string | null {
  return useStore((s) => (s.runtime.state === 'ready' ? s.runtime.url : null));
}

/** A library image as the project has it now: null once it has been removed (or for a font). */
export function useLibraryImage(assetId: string): AssetRecord | null {
  return useStore((s) => {
    const a = s.snapshot && Object.hasOwn(s.snapshot.state.assets.assets, assetId) ? s.snapshot.state.assets.assets[assetId] : null;
    return a?.kind === 'image' ? a : null;
  });
}

/** Every image in the library by ID and name, so a name shared with any of them is told apart. */
function useLibraryRefs(): ChatImageRef[] {
  const doc = useStore((s) => s.snapshot?.state.assets.assets);
  return useMemo(() => Object.values(doc ?? {}).flatMap((a) => (a?.kind === 'image' && typeof a.name === 'string' ? [{ assetId: a.id, name: a.name }] : [])), [doc]);
}

/**
 * Images as the library names them now (a renamed one by its new name), each told apart from any that share it in
 * the library or `among` (the images they were shown with, such as a question's offer, as they were named then).
 */
function useLabelled<T extends ChatImageRef>(images: T[], among: ChatImageRef[] = []) {
  const library = useLibraryRefs();
  return useMemo(() => {
    const live = new Map(library.map((r) => [r.assetId, r.name.trim()]));
    return imageLabels(
      images.map((i) => ({ ...i, name: live.get(i.assetId) || i.name })),
      [...library, ...among]
    );
  }, [images, library, among]);
}

/** Changes when an image's file goes missing or comes back, so a picture that failed to load tries again. */
function useFileState(assetId: string): string {
  return useStore((s) => {
    const m = s.snapshot?.missingAssets?.find((x) => x.assetId === assetId);
    return m ? `missing-${m.original}-${m.variants.length}` : 'present';
  });
}

/** The tile of a library image, loaded again once a missing file is back. */
function ChatThumb({ assetId }: { assetId: string }) {
  const live = useLibraryImage(assetId);
  const devUrl = useDevUrl();
  const fileState = useFileState(assetId);
  return <Thumb key={fileState} a={live} devUrl={devUrl} />;
}

const sizeOf = (a: AssetRecord | null) => (a?.width && a.height ? `${a.width} × ${a.height}` : '');

/**
 * One image named in a message: its picture and name, the asset ID when another image shown with it has the same
 * name, and (in the message being written) a button that takes it out again.
 */
export function ImageChip({ image, label, sharedName, onRemove }: { image: ChatImageRef; label: string; sharedName: boolean; onRemove?: () => void }) {
  const live = useLibraryImage(image.assetId);
  const name = image.name;
  return (
    <span className={`image-chip${live ? '' : ' missing'}`} title={live ? [name, sizeOf(live), live.description].filter(Boolean).join('\n') : `${name} is no longer in Assets`} data-asset-id={image.assetId}>
      <ChatThumb assetId={image.assetId} />
      <span className="image-chip-text">
        <span className="ellipsis">{name}</span>
        {sharedName && <span className="image-chip-id">{image.assetId}</span>}
        {!live && <span className="image-chip-id">Not in Assets</span>}
      </span>
      {onRemove && (
        <button type="button" aria-label={`Remove ${label} from the message`} title="Remove from the message" onClick={onRemove}>
          <X />
        </button>
      )}
    </span>
  );
}

/** Images named in a message, in order, each told apart from the others. */
export function ImageChips({ images, onRemove, label, among }: { images: ChatImageRef[]; onRemove?: (assetId: string) => void; label: string; among?: ChatImageRef[] }) {
  const labelled = useLabelled(images, among);
  if (!images.length) return null;
  return (
    <div className="image-chips" role="group" aria-label={label}>
      {labelled.map((i) => (
        <ImageChip key={i.assetId} image={i} label={i.label} sharedName={i.sharedName} onRemove={onRemove ? () => onRemove(i.assetId) : undefined} />
      ))}
    </div>
  );
}

/**
 * The pictures a waiting question offers. Each is chosen with one button, and a separate Preview button shows it
 * larger first; previewing (and closing the preview, Escape included) never answers. The pictures come from the
 * local preview: nothing is sent anywhere.
 */
export function ImageChoices({ images, onChoose }: { images: ChatImageRef[]; onChoose: (img: ChatImageRef) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const labelled = useLabelled(images);
  const shown = labelled.find((i) => i.assetId === preview) ?? null;
  return (
    <>
      <ul className="image-choices" aria-label="Pictures to choose from">
        {labelled.map((img) => (
          <ImageChoice key={img.assetId} img={img} onChoose={() => onChoose(img)} onPreview={() => setPreview(img.assetId)} />
        ))}
      </ul>
      {shown && (
        <ImagePreview
          img={shown}
          onClose={() => setPreview(null)}
          onChoose={() => {
            setPreview(null);
            onChoose(shown);
          }}
        />
      )}
    </>
  );
}

function ImageChoice({ img, onChoose, onPreview }: { img: ChatImageRef & { label: string; sharedName: boolean }; onChoose: () => void; onPreview: () => void }) {
  const live = useLibraryImage(img.assetId);
  const devUrl = useDevUrl();
  const fileState = useFileState(img.assetId);
  const detail = [sizeOf(live), live?.description?.trim()].filter(Boolean).join(' · ');
  return (
    <li className={`image-choice${live ? '' : ' missing'}`} data-asset-id={img.assetId}>
      <button
        type="button"
        className="image-choice-pick"
        disabled={!live}
        aria-label={live ? `Choose ${img.label}${detail ? `, ${detail}` : ''}` : `${img.label} is no longer in Assets`}
        title={live ? `Choose ${img.name}` : `${img.name} is no longer in Assets`}
        onClick={(e) => e.detail <= 1 && onChoose()}
      >
        <Thumb key={fileState} a={live} devUrl={devUrl} />
        <span className="image-choice-name">
          <span className="ellipsis">{img.name}</span>
          {img.sharedName && <span className="image-chip-id">{img.assetId}</span>}
          {!live && <span className="image-chip-id">Not in Assets</span>}
        </span>
      </button>
      <button type="button" className="icon-btn sm image-choice-preview" disabled={!live || !devUrl} aria-label={`Preview ${img.label}`} title={devUrl ? 'Preview larger' : 'The picture appears once the site preview is running'} onClick={onPreview}>
        <Expand />
      </button>
    </li>
  );
}

function ImagePreview({ img, onClose, onChoose }: { img: ChatImageRef & { label: string; sharedName: boolean }; onClose: () => void; onChoose: () => void }) {
  const live = useLibraryImage(img.assetId);
  const devUrl = useDevUrl();
  const fileState = useFileState(img.assetId);
  // Removed while it was open: there is nothing left to show or choose.
  if (!live) return null;
  return (
    <Modal
      title={img.sharedName ? img.label : img.name}
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Close
          </button>
          {/* Not focused on open: an Enter held down on Preview never chooses before the picture has been seen. */}
          <button className="btn btn-primary" onClick={(e) => e.detail <= 1 && onChoose()}>
            <Check /> Choose this picture
          </button>
        </>
      }
    >
      <div className="image-preview">
        <div className="image-preview-frame">
          <Picture key={fileState} a={live} devUrl={devUrl} original />
        </div>
        <p className="image-preview-meta">{[sizeOf(live), live.description?.trim()].filter(Boolean).join(' · ') || 'No description yet.'}</p>
      </div>
    </Modal>
  );
}
