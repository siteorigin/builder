import type { Collection, EntryDoc, EntrySeo, ProjectState } from '@shared/types';
import { entryRoute } from '@shared/collections';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { TEXT_LIMITS } from '@shared/text-limits';
import { DraftInput, Field, SwitchRow, useLockedFields } from '../components/ui';
import { CanonicalUrlField } from '../components/SeoFields';
import type { PictureStandIn } from '../lib/sharing';
import { getState } from '../store';
import { ImageEditor } from './PropEditors';
import { openSiteSharing } from './SharingPreview';
import type { DocumentPreview } from '../lib/seo-preview';
import { entryNounLower } from '../lib/content';
import { postSeoEdit, type PostSeoChange, type PostSeoEdit } from '../lib/post-seo';
import { LengthMeter, type TypedSeoOn } from './SeoPreview';

/**
 * A post's Search & sharing settings (#703): its search title and description with their length meters, its sharing
 * image, whether search engines and site search list it, and its canonical URL, in the order a page's are in. The post writer shows them beside its
 * previews, and the SEO view beside the view's: both work out each change the same way (`postSeoEdit`: text trimmed,
 * the same undo step) and hand it to `save`. `on` hears what the title, description and canonical URL fields show as
 * they are typed, for the previews beside them, and `doc` is what those previews show, for the meters.
 */
export function PostSearchFields({
  state,
  collection,
  entry,
  doc,
  on,
  save,
  ids
}: {
  state: ProjectState;
  collection: Collection;
  entry: EntryDoc;
  doc: DocumentPreview | null;
  on: TypedSeoOn;
  save: (edit: PostSeoEdit) => unknown;
  /** Starts the title's and description's ids, for a place that leads to them (the SEO view's findings). */
  ids?: string;
}) {
  const locked = useLockedFields();
  // Where text a field refused is kept, so it is still there when the post shows again, here or in the writer.
  const home = `entry:${collection.settings.id}:${entry.id}`;
  const alive = () => {
    const c = getState().snapshot?.state.collections;
    return !!c && Object.hasOwn(c, collection.settings.id) && Object.hasOwn(c[collection.settings.id].entries, entry.id);
  };
  // The post's search and sharing settings, and what it falls back to without each.
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  const defaultTitle = `${entry.title} · ${state.site.name}`;
  const base = publicUrl(state.site);
  // An entry with no page of its own (see pagesPrefix) has no address of its own either.
  const route = entryRoute(collection, entry);
  const ownUrl = base && route !== undefined ? base + routeUrl(route) : null;
  const published = entry.draft === false;
  // What one entry is called in a sentence: "post", or the collection's own noun.
  const noun = entryNounLower(collection);
  const isImage = (id: string | null | undefined): id is string => !!id && Object.hasOwn(state.assets.assets, id) && state.assets.assets[id].kind === 'image';
  // What a shared link shows without a picture of the post's own: its featured image, else the site's sharing image.
  const featured = isImage(entry.featuredImage);
  const siteImage = isImage(state.site.socialImage);
  const picker: PictureStandIn = {
    inherited: featured ? entry.featuredImage! : siteImage ? state.site.socialImage! : null,
    from: featured ? `The ${noun}’s featured image.` : 'The site’s sharing image.',
    none: 'No sharing image',
    back: featured ? 'Use the featured image' : siteImage ? 'Use the site’s image' : 'Remove image'
  };
  const shownId = seo.socialImage || picker.inherited;
  const imageName = shownId && isImage(shownId) ? state.assets.assets[shownId].name : undefined;
  const imageNote = seo.socialImage
    ? `This ${noun}’s own choice for shared links.`
    : featured
      ? `This ${noun} has no sharing image of its own, so a shared link shows its featured image. Choose one to use a different image.`
      : siteImage
        ? `This ${noun} has no sharing image or featured image, so a shared link shows the site’s sharing image. Choose one to use a different image.`
        : `Neither this ${noun} nor the site has a sharing image, so a shared link to it shows no picture.`;
  /** Save a change, when it changes anything. */
  const change = (c: PostSeoChange) => {
    const edit = postSeoEdit(entry, c);
    return edit ? save(edit) : undefined;
  };
  return (
    <>
      <div data-entry-field="seoTitle" style={{ display: 'contents' }}>
        <Field
          label="Search title"
          hint={
            <>
              The title search results and the browser tab show. {locked ? 'With none of its own it uses' : 'Leave empty to use'} “{defaultTitle}”.
              <LengthMeter kind="title" doc={doc} />
            </>
          }
        >
          <DraftInput id={ids && `${ids}-title`} keep={`${home}:seoTitle`} keepWhile={alive} value={seo.title ?? ''} limit={TEXT_LIMITS.seoTitle} onDirty={on.title} onCommit={(v) => change({ kind: 'title', text: v })} />
        </Field>
      </div>
      <div data-entry-field="seoDescription" style={{ display: 'contents' }}>
        <Field
          label="Description"
          hint={
            <>
              Shown by search engines and link previews. Leave empty to use {entry.excerpt?.trim() ? `the ${noun}’s excerpt` : `the site’s description (this ${noun} has no excerpt)`}.
              <LengthMeter kind="description" doc={doc} />
            </>
          }
        >
          <DraftInput id={ids && `${ids}-description`} keep={`${home}:seoDescription`} keepWhile={alive} multiline rows={3} value={seo.description ?? ''} limit={TEXT_LIMITS.pageDescription} placeholder={entry.excerpt || state.site.description || `Describe this ${noun}`} onDirty={on.description} onCommit={(v) => change({ kind: 'description', text: v })} />
        </Field>
      </div>
      {/* The post's own choice, or what it follows while it has none: the picker shows both, as a page's does. */}
      <fieldset className="col seo-field-group" disabled={locked} style={{ gap: 4 }} data-seo-field="socialImage" aria-label={`Sharing image: ${imageName ?? 'none'}`}>
        <ImageEditor
          title="Sharing image"
          value={{ assetId: seo.socialImage || null, alt: '' }}
          state={state}
          picture={picker}
          onChange={(v) => void change({ kind: 'socialImage', assetId: v.assetId })}
        />
        <div className="field-hint">{locked ? imageNote.replace(/ Choose one to use a different image\.$/, '') : imageNote}</div>
        {/* While it shows the site's image, that image is changed where the site keeps it, as a page's picker offers. */}
        {!seo.socialImage && !featured && !locked && (
          <button type="button" className="insp-mini" style={{ alignSelf: 'flex-start', marginLeft: -6 }} onClick={() => openSiteSharing('socialImage')}>
            Change the site’s sharing image
          </button>
        )}
      </fieldset>
      <SwitchRow
        checked={!!seo.noindex}
        onChange={(v) => void change({ kind: 'noindex', on: v })}
        label="Hide from search engines"
        hint={published ? 'When on, search engines are asked not to list it, and the sitemap leaves it out. Anyone with the address can still open it.' : 'When on, once it is published, search engines are asked not to list it, and the sitemap leaves it out.'}
      />
      <SwitchRow checked={!!seo.searchHidden} onChange={(v) => void change({ kind: 'searchHidden', on: v })} label="Hide from site search" hint={`When on, this ${noun} is left out of the site’s own search results, whatever search engines are told.`} />
      <CanonicalUrlField keep={`${home}:canonical`} keepWhile={alive} value={seo.canonical} ownUrl={ownUrl} what={noun} onTyped={on.canonical} onCommit={(url) => change({ kind: 'canonical', url })} />
    </>
  );
}
