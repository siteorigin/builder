import { useId, useMemo } from 'react';
import type { Collection, EntryDoc, EntrySeo, ProjectState } from '@shared/types';
import { entryRoute } from '@shared/collections';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { assetLabels, sortAssets } from '@shared/asset-order';
import { TEXT_LIMITS } from '@shared/text-limits';
import { DraftInput, Field, SwitchRow } from '../components/ui';
import { CanonicalUrlField } from '../components/SeoFields';
import type { DocumentPreview } from '../lib/seo-preview';
import { postSeoEdit, type PostSeoChange, type PostSeoEdit } from '../lib/post-seo';
import { LengthMeter, type TypedSeoOn } from './SeoPreview';

/**
 * A post's Search & sharing settings (#703): its browser title and description with their length meters, its sharing
 * image, its canonical URL, and whether search engines and site search list it. The post writer shows them beside its
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
  save
}: {
  state: ProjectState;
  collection: Collection;
  entry: EntryDoc;
  doc: DocumentPreview | null;
  on: TypedSeoOn;
  save: (edit: PostSeoEdit) => unknown;
}) {
  const uid = useId();
  // The post's search and sharing settings, and what it falls back to without each.
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  const defaultTitle = `${entry.title} · ${state.site.name}`;
  const base = publicUrl(state.site);
  // An entry with no page of its own (see pagesPrefix) has no address of its own either.
  const route = entryRoute(collection, entry);
  const ownUrl = base && route !== undefined ? base + routeUrl(route) : null;
  const published = entry.draft === false;
  const featured = entry.featuredImage && state.assets.assets[entry.featuredImage]?.kind === 'image';
  const inheritedImage = featured ? 'The featured image' : state.site.socialImage ? 'The site’s sharing image' : 'None';
  const images = useMemo(() => sortAssets(Object.values(state.assets.assets).filter((a) => a.kind === 'image'), 'name'), [state.assets]);
  const labels = useMemo(() => assetLabels(images), [images]);
  /** Save a change, when it changes anything. */
  const change = (c: PostSeoChange) => {
    const edit = postSeoEdit(entry, c);
    return edit ? save(edit) : undefined;
  };
  return (
    <>
      <div data-entry-field="seoTitle" style={{ display: 'contents' }}>
        <Field
          label="Browser title"
          hint={
            <>
              Leave empty to use “{defaultTitle}”.
              <LengthMeter kind="title" doc={doc} />
            </>
          }
        >
          <DraftInput value={seo.title ?? ''} limit={TEXT_LIMITS.seoTitle} placeholder={defaultTitle} onDirty={on.title} onCommit={(v) => change({ kind: 'title', text: v })} />
        </Field>
      </div>
      <div data-entry-field="seoDescription" style={{ display: 'contents' }}>
        <Field
          label="Description"
          hint={
            <>
              Shown by search engines and link previews. Leave empty to use the excerpt.
              <LengthMeter kind="description" doc={doc} />
            </>
          }
        >
          <DraftInput multiline rows={3} value={seo.description ?? ''} limit={TEXT_LIMITS.pageDescription} placeholder={entry.excerpt || state.site.description || 'Describe this post'} onDirty={on.description} onCommit={(v) => change({ kind: 'description', text: v })} />
        </Field>
      </div>
      <Field label="Sharing image" controlId={`${uid}-sharing`} hint="The picture link previews show.">
        <select id={`${uid}-sharing`} className="select" value={seo.socialImage ?? ''} onChange={(e) => void change({ kind: 'socialImage', assetId: e.target.value || null })}>
          <option value="">{inheritedImage}</option>
          {seo.socialImage && !images.some((a) => a.id === seo.socialImage) && <option value={seo.socialImage}>Missing image</option>}
          {images.map((a) => (
            <option key={a.id} value={a.id}>
              {labels.get(a.id)?.label ?? a.name}
            </option>
          ))}
        </select>
      </Field>
      <CanonicalUrlField value={seo.canonical} ownUrl={ownUrl} what="post" onTyped={on.canonical} onCommit={(url) => change({ kind: 'canonical', url })} />
      <SwitchRow
        checked={!!seo.noindex}
        onChange={(v) => void change({ kind: 'noindex', on: v })}
        label="Hide from search engines"
        hint={published ? 'Search engines are asked not to list it, and the sitemap leaves it out. Anyone with the address can still open it.' : 'Once published, search engines are asked not to list it, and the sitemap leaves it out.'}
      />
      <SwitchRow checked={!!seo.searchHidden} onChange={(v) => void change({ kind: 'searchHidden', on: v })} label="Hide from site search" hint="Keeps this post out of the site’s own search results, whatever search engines are told." />
    </>
  );
}
