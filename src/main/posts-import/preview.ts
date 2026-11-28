/** A posts import's plan as the author reviews it (see PostImportPreview). */
import type { PostImportPreview } from '@shared/api';
import { isImageBlock } from '@shared/richtext';
import { selectPlan, type PostImportPlan } from './plan';

/** The same file shown under two references (`photo.jpg`, `./photo.jpg`) is one picture. */
const pictures = (plan: PostImportPlan) => new Set(plan.media.map((m) => m.path)).size;
const missing = (plan: PostImportPlan) => plan.missing.map(({ post, ref, problem }) => ({ post, ref, problem }));
const newTerms = (plan: PostImportPlan) => ({ categories: plan.newTerms.categories, tags: plan.newTerms.tags });

/**
 * The review of `plan`: every post, those already in the project marked, and the rest as importing with them skipped
 * (the default) brings it. With posts already here, `update` says what updating them instead brings.
 */
export function postImportPreview(id: string, plan: PostImportPlan): PostImportPreview {
  const labels = (tax: 'categories' | 'tags', ids: string[] | undefined) => (ids ?? []).map((t) => plan.termLabels[tax][t] ?? t);
  const existing = plan.posts.filter((p) => p.existing).length;
  const skip = selectPlan(plan, 'skip');
  const update = existing ? selectPlan(plan, 'update') : null;
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
      ...(p.existing ? { existing: true, ...(p.existing.unread ? { unread: true } : {}) } : {}),
      pictures: p.body.filter(isImageBlock).length + (p.featured ? 1 : 0),
      categories: labels('categories', p.terms.categories),
      tags: labels('tags', p.terms.tags),
      notes: p.notes
    })),
    existing,
    pictures: pictures(skip),
    missing: missing(skip),
    newTerms: newTerms(skip),
    redirects: plan.posts.filter((p) => p.redirectFrom).length,
    redirectsPending: plan.posts.filter((p) => p.redirectFrom && p.draft).length,
    redirectsLost: plan.posts.filter((p) => p.lostAddress).length,
    skipped: plan.skipped,
    oldSiteLinks: skip.oldSiteLinks,
    problems: skip.problems,
    ...(update ? { update: { posts: update.posts.filter((p) => p.existing).length, pictures: pictures(update), missing: missing(update), newTerms: newTerms(update), oldSiteLinks: update.oldSiteLinks, problems: update.problems } } : {})
  };
}
