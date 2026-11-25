/**
 * A post's Search & sharing settings as they are saved (#703), from the post writer or the SEO view alike: what each
 * change writes and the undo step it is named by, worked out the same way wherever it was made, and the save itself,
 * which the writer follows as one of its own when it holds the same post.
 */
import type { EntryDoc, EntrySeo } from '@shared/types';
import { applyOps } from '../store';
import { followPostChange } from './post-draft';
import type { PostRef } from './posts';

/** One change to a post's search settings, as its control reports it. */
export type PostSeoChange =
  | { kind: 'title' | 'description'; text: string }
  | { kind: 'socialImage'; assetId: string | null }
  | { kind: 'canonical'; url: string }
  | { kind: 'noindex' | 'searchHidden'; on: boolean };

/** What a change writes into the post (an `entry.update`'s fields), and the undo step it is named by. */
export interface PostSeoEdit {
  fields: Record<string, unknown>;
  label: string;
}

/**
 * The edit a change makes to `entry` as it is saved now, or null when it changes nothing: a title or description is
 * trimmed first, so text that differs from the saved one only by spaces at its ends writes nothing.
 */
export function postSeoEdit(entry: EntryDoc, change: PostSeoChange): PostSeoEdit | null {
  const seo: EntrySeo = entry.seo && typeof entry.seo === 'object' ? entry.seo : {};
  switch (change.kind) {
    case 'title': {
      const text = change.text.trim();
      return text !== (seo.title ?? '') ? { fields: { seoTitle: text }, label: 'Change post browser title' } : null;
    }
    case 'description': {
      const text = change.text.trim();
      return text !== (seo.description ?? '') ? { fields: { description: text }, label: 'Change post description' } : null;
    }
    case 'socialImage':
      return { fields: { socialImage: change.assetId || null }, label: change.assetId ? 'Change post sharing image' : 'Use the default sharing image' };
    case 'canonical':
      return { fields: { canonical: change.url }, label: change.url ? 'Change post canonical URL' : 'Clear post canonical URL' };
    case 'noindex':
      return { fields: { noindex: change.on }, label: change.on ? 'Hide post from search engines' : 'Show post to search engines' };
    case 'searchHidden':
      return { fields: { searchHidden: change.on }, label: change.on ? 'Hide post from site search' : 'Show post in site search' };
  }
}

/**
 * Save an edit of `post`'s search settings made outside the post writer (the SEO view): written as the writer writes
 * its own, and when the writer holds that same post, followed by it as one of its own field changes, so its Publish
 * and Save draft wait for it and hear when it was refused. Resolves to the project's answer, or null when refused.
 */
export function savePostSeo(post: PostRef, edit: PostSeoEdit): Promise<Array<Record<string, unknown>> | null> {
  const saved = applyOps([{ type: 'entry.update', collectionId: post.collectionId, entryId: post.entryId, ...edit.fields } as never], edit.label);
  followPostChange(post, saved);
  return saved;
}
