import type { PageDoc, ProjectState } from '@shared/types';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { TEXT_LIMITS } from '@shared/text-limits';
import { pageAlive, type PageUpd } from '../lib/page-settings';
import { DraftInput, Field, InfoTip, SwitchRow, useLockedFields } from '../components/ui';
import { CanonicalUrlField, RevisionDateField } from '../components/SeoFields';
import { SHARING_IMAGE_SHAPE, sharingView } from '../lib/sharing';
import type { DocumentPreview } from '../lib/seo-preview';
import { ImageEditor } from './PropEditors';
import { openSiteSharing } from './SharingPreview';
import { LengthMeter, type TypedSeoOn } from './SeoPreview';

/**
 * A page's Search & sharing settings: its search title (the browser tab's too) and description with their length meters, sharing image,
 * canonical URL, whether search engines and the site's own search list it, and when it was last revised. They are the
 * same fields in the Inspector and the SEO view (#702), saving through `upd` alike. Text typed and not saved yet is
 * reported through `on`, for the previews; `doc` is what those previews show, for the meters. Text refused for being
 * too long is kept under the page's own place, so the field finds it again wherever it next shows. `ids` starts each
 * field's id, so the two places never share one.
 */
export function PageSearchFields({ page, state, draft, upd, on, doc, ids = 'page-seo' }: { page: PageDoc; state: ProjectState; draft: boolean; upd: PageUpd; on: TypedSeoOn; doc: DocumentPreview | null; ids?: string }) {
  const isHome = page.id === state.site.homePageId;
  const locked = useLockedFields();
  // How a shared link to the page looks, and whose sharing image it carries.
  const sharing = sharingView(state, page);
  const base = publicUrl(state.site);
  const ownUrl = base ? base + routeUrl(page.route) : null;
  // What results and the browser tab show while it has no title of its own, said in the field too.
  const defaultTitle = isHome ? state.site.name : `${page.title} · ${state.site.name}`;
  // Locked, the explanation says which image is in use, never what to do about it.
  const imageInfo = `${locked ? sharing.imageNote.replace(/ Choose (one|another)[^.]*\.$/, '') : sharing.imageNote} ${SHARING_IMAGE_SHAPE}`;
  return (
    <>
      <Field label="Search title" hint={<LengthMeter kind="title" doc={doc} />} info={page.seo.title ? `The title search results and the browser tab show. ${locked ? 'With none of its own it uses' : 'Leave empty to use'} “${defaultTitle}”.` : 'The title search results and the browser tab show.'}>
        <DraftInput id={`${ids}-title`} limit={TEXT_LIMITS.seoTitle} keep={`page:${page.id}:seoTitle`} keepWhile={pageAlive(page.id)} value={page.seo.title ?? ''} placeholder={defaultTitle} quietCount onDirty={on.title} onCommit={(v) => upd({ seoTitle: v }, 'Change browser title')} />
      </Field>
      <Field label="Description" hint={<LengthMeter kind="description" doc={doc} />}>
        <DraftInput id={`${ids}-description`} multiline quietCount limit={TEXT_LIMITS.pageDescription} keep={`page:${page.id}:description`} keepWhile={pageAlive(page.id)} value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onDirty={on.description} onCommit={(v) => upd({ description: v }, 'Change page description')} />
      </Field>
      {/* The page's own choice, or the site's while it has none: the picker shows both, and Use the site’s image returns to it. */}
      <div className="col seo-field-group" style={{ gap: 4 }} data-seo-field="socialImage">
        <fieldset className="col seo-field-group" disabled={locked} style={{ gap: 4 }} aria-label={`Sharing image: ${sharing.imageName ?? 'none'}`} aria-describedby={sharing.imageStatus ? `${ids}-image-status` : undefined}>
          <ImageEditor
            title="Sharing image"
            value={{ assetId: page.seo.socialImage || null, alt: '' }}
            state={state}
            picture={sharing.picker}
            info={locked ? undefined : imageInfo}
            onChange={(v) => upd({ socialImage: v.assetId }, v.assetId ? 'Change sharing image' : sharing.picker.inherited ? 'Use the site’s sharing image' : 'Remove sharing image')}
          />
        </fieldset>
        {/* One line for what the picker can't show itself, with the way to the site's image. Outside the fieldset, so a
            locked project's explanation can still be opened. */}
        <div className="field-hint seo-image-status">
          {sharing.imageStatus && <span id={`${ids}-image-status`}>{sharing.imageStatus}</span>}
          {locked ? (
            <InfoTip label="Sharing image">{imageInfo}</InfoTip>
          ) : (
            <button type="button" className="link-btn" aria-label={sharing.imageSource === 'none' ? undefined : 'Change the site’s sharing image'} onClick={() => openSiteSharing('socialImage')}>
              {sharing.imageSource === 'none' ? 'Set a site image' : sharing.imageSource === 'site' ? 'Change' : 'Change site image'}
            </button>
          )}
        </div>
      </div>
      <SwitchRow
        id={`${ids}-noindex`}
        checked={!!page.seo.noindex}
        onChange={(v) => upd({ noindex: v })}
        label="Hide from search engines"
        hint={page.seo.noindex && !draft ? 'Anyone with the address can still open it' : undefined}
        info={page.seo.noindex ? (draft ? 'Once the page is published, search engines are asked not to list it. Anyone with the address can still open it.' : 'Search engines are asked not to list this page.') : draft ? 'Once published, anyone with the address can open this page. Turn this on to ask search engines not to list it.' : 'Turn it on to ask search engines not to list this page. Anyone with the address can still open it.'}
      />
      <SwitchRow checked={!!page.seo.searchHidden} onChange={(v) => upd({ searchHidden: v })} label="Hide from site search" info={draft ? 'Once published, hides the page from this site’s own search. Search engines follow the setting above.' : 'Hides the page from this site’s own search. Search engines follow the setting above.'} />
      <CanonicalUrlField id={`${ids}-canonical`} keep={`page:${page.id}:canonical`} keepWhile={pageAlive(page.id)} value={page.seo.canonical} ownUrl={ownUrl} what="page" onTyped={on.canonical} onCommit={(url) => upd({ canonical: url }, url ? 'Change canonical URL' : 'Clear canonical URL')} />
      <RevisionDateField
        id={`${ids}-updated`}
        label="Last revised"
        info="When the page’s content last changed, for the sitemap."
        value={page.updatedAt}
        onSet={(v) => upd({ updatedAt: v }, 'Change revision date')}
        onClear={() => upd({ updatedAt: null }, 'Clear revision date')}
      />
    </>
  );
}
