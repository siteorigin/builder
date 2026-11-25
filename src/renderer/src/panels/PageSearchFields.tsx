import type { PageDoc, ProjectState } from '@shared/types';
import type { EditOperation } from '@shared/ops';
import { publicUrl } from '@shared/public-url';
import { routeUrl } from '@shared/routes';
import { TEXT_LIMITS } from '@shared/text-limits';
import { applyOps, getState } from '../store';
import { DraftInput, Field, SwitchRow } from '../components/ui';
import { CanonicalUrlField, RevisionDateField } from '../components/SeoFields';
import { sharingView } from '../lib/sharing';
import type { DocumentPreview } from '../lib/seo-preview';
import { ImageEditor } from './PropEditors';
import { openSiteSharing } from './SharingPreview';
import { LengthMeter, type TypedSeoOn } from './SeoPreview';

/** Whether a page is still in the project: text kept for one of its fields goes with it (see DraftInput's keepWhile). */
export const pageAlive = (id: string) => () => Object.hasOwn(getState().snapshot?.state.pages ?? {}, id);

/** Saves a change to one page's settings. */
export type PageUpd = (patch: Record<string, unknown>, label?: string) => void;

/**
 * How a page's settings are saved, wherever they are edited (the Inspector, the SEO view): one `page.update`, with a
 * history label naming the page ("Change browser title (About)"), so undo reads the same from either place.
 */
export const pageUpdater =
  (page: PageDoc): PageUpd =>
  (patch, label = 'Update page settings') =>
    void applyOps([{ type: 'page.update', pageId: page.id, ...patch } as EditOperation], `${label} (${page.title})`);

/**
 * A page's Search & sharing settings: its browser title and description with their length meters, sharing image,
 * canonical URL, whether search engines and the site's own search list it, and when it was last revised. They are the
 * same fields in the Inspector and the SEO view (#702), saving through `upd` alike. Text typed and not saved yet is
 * reported through `on`, for the previews; `doc` is what those previews show, for the meters. Text refused for being
 * too long is kept under the page's own place, so the field finds it again wherever it next shows. `ids` starts each
 * field's id, so the two places never share one.
 */
export function PageSearchFields({ page, state, draft, upd, on, doc, ids = 'page-seo' }: { page: PageDoc; state: ProjectState; draft: boolean; upd: PageUpd; on: TypedSeoOn; doc: DocumentPreview | null; ids?: string }) {
  const isHome = page.id === state.site.homePageId;
  // How a shared link to the page looks, and whose sharing image it carries.
  const sharing = sharingView(state, page);
  const base = publicUrl(state.site);
  const ownUrl = base ? base + routeUrl(page.route) : null;
  return (
    <>
      <Field
        label="Browser title"
        hint={
          <>
            Leave empty to use “{isHome ? state.site.name : `${page.title} · ${state.site.name}`}”.
            <LengthMeter kind="title" doc={doc} />
          </>
        }
      >
        <DraftInput id={`${ids}-title`} limit={TEXT_LIMITS.seoTitle} keep={`page:${page.id}:seoTitle`} keepWhile={pageAlive(page.id)} value={page.seo.title ?? ''} onDirty={on.title} onCommit={(v) => upd({ seoTitle: v }, 'Change browser title')} />
      </Field>
      <Field
        label="Description"
        hint={
          <>
            Shown by search engines and link previews.
            <LengthMeter kind="description" doc={doc} />
          </>
        }
      >
        <DraftInput id={`${ids}-description`} multiline limit={TEXT_LIMITS.pageDescription} keep={`page:${page.id}:description`} keepWhile={pageAlive(page.id)} value={page.seo.description ?? ''} placeholder={state.site.description || 'Describe this page'} onDirty={on.description} onCommit={(v) => upd({ description: v }, 'Change page description')} />
      </Field>
      {/* The page's own choice, or the site's while it has none: the picker shows both, and Use the site’s image returns to it. */}
      <div className="col" style={{ gap: 4 }} data-seo-field="socialImage">
        <ImageEditor
          title="Sharing image"
          value={{ assetId: page.seo.socialImage || null, alt: '' }}
          state={state}
          picture={sharing.picker}
          onChange={(v) => upd({ socialImage: v.assetId }, v.assetId ? 'Change sharing image' : sharing.picker.inherited ? 'Use the site’s sharing image' : 'Remove sharing image')}
        />
        <div className="field-hint">{sharing.imageNote}</div>
        <button type="button" className="insp-mini" style={{ alignSelf: 'flex-start', marginLeft: -6 }} onClick={() => openSiteSharing('socialImage')}>
          Change the site’s sharing image
        </button>
      </div>
      <SwitchRow
        id={`${ids}-noindex`}
        checked={!!page.seo.noindex}
        onChange={(v) => upd({ noindex: v })}
        label="Hide from search engines"
        hint={
          draft
            ? 'Once published, search engines are asked not to list it. Anyone with the address can still open it.'
            : 'Search engines are asked not to list it. Anyone with the address can still open it.'
        }
      />
      <SwitchRow checked={!!page.seo.searchHidden} onChange={(v) => upd({ searchHidden: v })} label="Hide from site search" hint={draft ? 'Once published, leaves this page out of the site’s own Site search results.' : 'Leaves this page out of the site’s own Site search results.'} />
      <CanonicalUrlField id={`${ids}-canonical`} keep={`page:${page.id}:canonical`} keepWhile={pageAlive(page.id)} value={page.seo.canonical} ownUrl={ownUrl} what="page" onTyped={on.canonical} onCommit={(url) => upd({ canonical: url }, url ? 'Change canonical URL' : 'Clear canonical URL')} />
      <RevisionDateField
        id={`${ids}-updated`}
        label="Last revised"
        hint="When the page’s content last changed, for the sitemap. Leave empty to give no date."
        value={page.updatedAt}
        onSet={(v) => upd({ updatedAt: v }, 'Change revision date')}
        onClear={() => upd({ updatedAt: null }, 'Clear revision date')}
      />
    </>
  );
}
