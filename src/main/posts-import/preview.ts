/** A posts import's plan as the author reviews it (see PostImportPreview). */
import type { PostImportPreview } from '@shared/api';
import { isImageBlock } from '@shared/richtext';
import type { PostImportPlan } from './plan';

export function postImportPreview(id: string, plan: PostImportPlan): PostImportPreview {
  const labels = (tax: 'categories' | 'tags', ids: string[] | undefined) => (ids ?? []).map((t) => plan.termLabels[tax][t] ?? t);
  return {
    id,
    kind: plan.source.kind,
    source: plan.source.label,
    ...(plan.source.site ? { site: plan.source.site } : {}),
    collection: { name: plan.collection.name, route: plan.collection.route, create: plan.collection.create },
    posts: plan.posts.map((p) => ({
      title: p.title,
      from: p.from,
      date: p.date,
      ...(p.dateAssigned ? { dateAssigned: true } : {}),
      draft: p.draft,
      ...(p.draftReason ? { draftReason: p.draftReason } : {}),
      route: p.route,
      ...(p.wantedSlug ? { wantedSlug: p.wantedSlug } : {}),
      ...(p.redirectFrom ? { redirectFrom: p.redirectFrom } : {}),
      pictures: p.body.filter(isImageBlock).length + (p.featured ? 1 : 0),
      categories: labels('categories', p.terms.categories),
      tags: labels('tags', p.terms.tags),
      notes: p.notes
    })),
    // The same file shown under two references (`photo.jpg`, `./photo.jpg`) is one picture.
    pictures: new Set(plan.media.map((m) => m.path)).size,
    missing: plan.missing,
    newTerms: { categories: plan.newTerms.categories, tags: plan.newTerms.tags },
    redirects: plan.posts.filter((p) => p.redirectFrom).length,
    redirectsLost: plan.posts.filter((p) => p.lostAddress).length,
    skipped: plan.skipped,
    oldSiteLinks: plan.oldSiteLinks,
    problems: plan.problems
  };
}
