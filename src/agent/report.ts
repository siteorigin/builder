import type { ChatChange, ChatCheck } from '@shared/api';
import { propBindingValue } from '@shared/bindings';
import type { EditOperation } from '@shared/ops';
import type { AltReview, GraphNode, ImageValue, OwnerRef, ProjectState, PropSchema } from '@shared/types';
import { isBinding } from '@shared/types';
import { pageArticle } from '@shared/articles';
import { findEntry } from '@shared/collections';
import { STYLE_PROPS } from '@shared/styles';
import { catalogueComponent, getTheme } from '@catalogue/index';
import { declaredTokens } from '@engine/tokens';
import { displayName, getTree } from '@engine/tree';
import { altStillToCheck } from '@engine/alt-review';
import type { HomeChange } from '@engine/apply';
import type { CheckCount, InspectionChecks } from '@shared/inspection';
import { shellPageLinks } from '@generator/checks';

// ---------------------------------------------------------------------------
// Changes: what the run did, in words an author can act on
// ---------------------------------------------------------------------------

const PRIMITIVES: Record<string, string> = { richtext: 'rich text', repeat: 'repeated items', slot: 'content area' };
const CONTENT_FIELDS: Record<string, string> = { text: 'text', link: 'link', label: 'button text', appearance: 'button style', icon: 'icon', tag: 'heading level', anchor: 'anchor', collapseEmpty: 'hiding when empty', interactionGroup: 'interaction group', appear: 'entrance', appearStagger: 'staggered entrances', webmcpToolName: 'agent tool name', webmcpToolDescription: 'agent tool description' };
const SITE_FIELDS: Record<string, string> = { name: 'name', language: 'language', direction: 'text direction', description: 'description', baseUrl: 'web address', favicon: 'favicon', socialImage: 'sharing image', notFoundHeading: 'not-found page heading', notFoundMessage: 'not-found page message', notFoundLinkLabel: 'not-found page link', visitorText: 'visitor text', identity: 'publisher details', llmsTxt: 'llms.txt', llmsFull: 'llms-full.txt', markdownMirrors: 'Markdown copies', llmsSummary: 'llms.txt summary', webmcp: 'WebMCP tools', crawlerPolicy: 'crawler policy', redirectHost: 'host for redirects' };
const PAGE_FIELDS: Record<string, string> = { title: 'title', route: 'address', navLabel: 'menu label', seoTitle: 'search title', description: 'description', noindex: 'search visibility', searchHidden: 'site search visibility', draft: 'draft status', showHeader: 'shared header', showFooter: 'shared footer', socialImage: 'sharing image', canonical: 'canonical URL', updatedAt: 'revision date', language: 'language', linkTranslationTo: 'translations', articleDate: 'publication date', byline: 'byline', excerpt: 'excerpt', newsHidden: 'news list visibility', article: 'article status', structuredData: 'structured data' };

/** A property label as it reads inside a sentence: "Title" becomes "title", "CTA link" stays. */
const inSentence = (label: string) => (/^[A-Z][a-z]/.test(label) ? label[0].toLowerCase() + label.slice(1) : label);
const quoted = (s: string) => `“${s}”`;
/** "a", "a and b", "a, b and c". */
export function joinWords(items: string[]): string {
  if (items.length < 2) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

interface Draft {
  key: string;
  operations: Set<string>;
  details: string[];
  /** How many operations the entry stands for ("Added 2 items"). */
  count: number;
  render: (details: string[], count: number) => string;
  link: Omit<ChatChange, 'label' | 'operations'>;
}

/**
 * The completion card's change list. Each entry names what changed and where, links to the element when
 * there is one, and keeps the raw operation types as technical detail. Content edits to one element are
 * merged into one entry ("Set the image and alt text of Image on Contact"), and so are its style edits.
 */
export function describeOps(ops: EditOperation[], before: ProjectState, after: ProjectState, results: unknown[]): ChatChange[] {
  const drafts = new Map<string, Draft>();
  const add = (op: EditOperation, key: string, render: Draft['render'], link: Draft['link'] = {}, detail?: string) => {
    let d = drafts.get(key);
    if (!d) drafts.set(key, (d = { key, operations: new Set(), details: [], count: 0, render, link }));
    d.operations.add(op.type);
    d.count++;
    if (detail && !d.details.includes(detail)) d.details.push(detail);
  };
  const tree = (state: ProjectState, o: OwnerRef) => {
    try {
      return getTree(state, o);
    } catch {
      return null;
    }
  };
  const nodeIn = (state: ProjectState, o: OwnerRef, id: string | undefined): GraphNode | undefined => (id ? tree(state, o)?.nodes[id] : undefined);
  const componentName = (id: string) => after.components[id]?.name ?? before.components[id]?.name ?? 'component';
  const where = (o: OwnerRef) =>
    o.kind === 'page'
      ? (after.pages[o.id]?.title ?? before.pages[o.id]?.title ?? 'a page')
      : o.kind === 'shell'
        ? o.id === 'header'
          ? 'the shared header'
          : 'the shared footer'
        : `the ${quoted(componentName(o.id))} component`;
  /** The element's name as the Layers panel shows it, from after the run or, for a removed one, before it. */
  const name = (o: OwnerRef, id: string) => {
    const now = nodeIn(after, o, id);
    if (now) return displayName(after, now);
    const was = nodeIn(before, o, id);
    return was ? displayName(before, was) : 'an element';
  };
  /** Where the card's link goes: the element when it still exists, otherwise its page. */
  const linkTo = (o: OwnerRef, id?: string): Draft['link'] => {
    const exists = !!nodeIn(after, o, id);
    if (o.kind === 'page') return after.pages[o.id] ? { owner: o, pageId: o.id, ...(exists ? { nodeId: id } : {}) } : {};
    if (o.kind === 'shell') return exists ? { owner: o, nodeId: id } : {};
    return after.components[o.id] ? { owner: o, definitionId: o.id, ...(exists ? { nodeId: id } : {}) } : {};
  };
  const ownerKey = (o: OwnerRef) => `${o.kind}:${o.id}`;
  const propSchema = (o: OwnerRef, nodeId: string, prop: string): PropSchema | undefined => {
    const n = nodeIn(after, o, nodeId) ?? nodeIn(before, o, nodeId);
    if (n?.kind !== 'instance') return undefined;
    return (after.components[n.definitionId] ?? before.components[n.definitionId])?.properties[prop];
  };
  /** An element edited in this run that did not exist before it was "set"; an existing one was "changed". */
  const verb = (o: OwnerRef, id: string) => (nodeIn(before, o, id) ? 'Changed' : 'Set');
  /** The element and where it is, said once: the shared header's own Header is "the shared header", not "Header on the shared header". */
  const nameOn = (o: OwnerRef, id: string) => {
    const n = name(o, id);
    return o.kind === 'shell' && n.trim().toLowerCase() === o.id ? where(o) : `${n} on ${where(o)}`;
  };
  const contentEdit = (op: EditOperation & { owner: OwnerRef; nodeId: string }, detail: string) =>
    add(op, `content:${ownerKey(op.owner)}:${op.nodeId}`, (d) => `${verb(op.owner, op.nodeId)} the ${joinWords(d)} of ${nameOn(op.owner, op.nodeId)}`, linkTo(op.owner, op.nodeId), detail);
  const styleEdit = (op: EditOperation & { owner: OwnerRef; nodeId: string }, detail: string) =>
    add(op, `style:${ownerKey(op.owner)}:${op.nodeId}`, (d) => `Changed the ${joinWords(d)} of ${nameOn(op.owner, op.nodeId)}`, linkTo(op.owner, op.nodeId), detail);
  /** An image value as shown: one bound to a component property shows that property's default. */
  const shownImage = (state: ProjectState, o: OwnerRef, value: unknown): Partial<ImageValue> => {
    const v = isBinding(value) && '$prop' in value && o.kind === 'component' ? propBindingValue(state.components[o.id]?.properties[value.$prop]?.default, value) : value;
    return (v && typeof v === 'object' && !isBinding(v) ? v : {}) as Partial<ImageValue>;
  };
  /** What an image edit changed: the picture, its alt text, or whether it is decorative. */
  const imageParts = (a: Partial<ImageValue>, b: Partial<ImageValue>, label = 'image'): string[] => {
    const asset = b.assetId ? (after.assets.assets[b.assetId]?.name ?? null) : null;
    const parts: string[] = [];
    if ((a.assetId ?? null) !== (b.assetId ?? null)) parts.push(asset ? `${label} (${quoted(asset)})` : label);
    if ((a.alt ?? '') !== (b.alt ?? '')) parts.push('alt text');
    if (!!a.decorative !== !!b.decorative) parts.push('decorative setting');
    return parts.length ? parts : [label];
  };
  const tokenLabel = (id: string) => [...declaredTokens(after), ...declaredTokens(before)].find((t) => t.id === id)?.label ?? id;
  const assetName = (id: string | null | undefined) => (id ? (after.assets.assets[id]?.name ?? before.assets.assets[id]?.name ?? 'an image') : 'an image');
  const collectionName = (id: string) => after.collections[id]?.settings.name ?? before.collections[id]?.settings.name ?? id;
  const entryTitle = (cid: string, id: string) => after.collections[cid]?.entries[id]?.title ?? before.collections[cid]?.entries[id]?.title ?? id;
  /** "Posts categories": a collection's grouping, by the names they had before the change. */
  const termGrouping = (cid: string, tax: string) => {
    const c = before.collections[cid] ?? after.collections[cid];
    const t = c?.settings.taxonomies?.[tax] ?? after.collections[cid]?.settings.taxonomies?.[tax];
    return `${collectionName(cid)} ${(t?.label ?? tax).toLowerCase()}`;
  };
  const termLabel = (cid: string, tax: string, id: string) => before.collections[cid]?.settings.taxonomies?.[tax]?.terms?.[id]?.label ?? id;
  const plain = (op: EditOperation, label: string, link: Draft['link'] = {}) => add(op, `plain:${label}:${JSON.stringify(link)}`, () => label, link);
  const items = (n: number) => (n === 1 ? 'an item' : `${n} items`);

  ops.forEach((op, i) => {
    const res = (results[i] ?? {}) as Record<string, string | undefined>;
    switch (op.type) {
      case 'page.create':
        return plain(op, `Added page ${quoted(op.title)}${res.route ? ` (${res.route})` : ''}`, res.pageId && after.pages[res.pageId] ? { owner: { kind: 'page', id: res.pageId }, pageId: res.pageId } : {});
      case 'page.update': {
        const o: OwnerRef = { kind: 'page', id: op.pageId };
        const render = (d: string[]) => `Changed the ${d.length ? joinWords(d) : 'settings'} of page ${where(o)}`;
        const fields = Object.keys(PAGE_FIELDS).filter((f) => (op as Record<string, unknown>)[f] !== undefined);
        if (!fields.length) add(op, `page:${op.pageId}`, render, linkTo(o));
        else fields.forEach((f) => add(op, `page:${op.pageId}`, render, linkTo(o), PAGE_FIELDS[f]));
        // A new address moves the pages inside the page too (see shared/page-tree.ts): say so, naming them.
        // Where each is at the end of the run.
        const moved = ((results[i] ?? {}) as { moved?: Array<{ pageId: string }> }).moved?.filter((m) => m.pageId !== op.pageId && after.pages[m.pageId]) ?? [];
        if (moved.length) plain(op, `Moved ${joinWords(moved.map((m) => `${where({ kind: 'page', id: m.pageId })} (now ${after.pages[m.pageId].route})`))} with it`);
        return;
      }
      case 'page.duplicate':
        return plain(op, `Duplicated page ${where({ kind: 'page', id: op.pageId })}`, res.pageId && after.pages[res.pageId] ? { owner: { kind: 'page', id: res.pageId }, pageId: res.pageId } : {});
      case 'page.reorder':
        return plain(op, 'Reordered the pages');
      case 'page.remove': {
        // Its cards in page lists went with it: name the pages those lists are on, from the removal's own result.
        const cards = ((results[i] ?? {}) as { removedCards?: unknown }).removedCards;
        const where = Array.isArray(cards) ? cards.filter((w): w is string => typeof w === 'string') : [];
        const on = [...new Set(where.map(quoted))];
        const also = on.length ? ` and its card${where.length === 1 ? '' : 's'} on ${joinWords(on)}` : '';
        return plain(op, `Removed page ${quoted(before.pages[op.pageId]?.title ?? 'page')}${also}`);
      }
      case 'page.setHome': {
        // The addresses this promotion moved, from its own result: a later edit in the run may move them again.
        const change = (results[i] ?? {}) as Partial<HomeChange>;
        const title = (id: string) => quoted(after.pages[id]?.title ?? before.pages[id]?.title ?? 'page');
        const moved = (change.moved ?? []).map((m) => `${title(m.pageId)} moved from ${m.from} to ${m.to}`);
        // Only while it is still true at the end of the run: a later edit may have given the address to a page.
        const stillKept = (Array.isArray(after.site.redirects) ? after.site.redirects : []).some((r) => r.from.toLowerCase() === change.kept?.toLowerCase() && r.pageId === op.pageId);
        const kept = change.kept && stillKept ? ` ${change.kept} still works and sends visitors to ${title(op.pageId)}.` : '';
        // Header and footer links keep their words but now lead to the new addresses: name them for review.
        const links = shellPageLinks(after, (change.moved ?? []).map((m) => m.pageId)).map((l) => (l.label ? quoted(l.label) : 'a link without text'));
        const review = links.length ? ` Check the header and footer links ${joinWords([...new Set(links)])}: they keep their words and go to the new addresses.` : '';
        const label = `Made ${where({ kind: 'page', id: op.pageId })} the home page${moved.length ? `: ${joinWords(moved)}.` : ''}${kept}${review}`;
        return plain(op, label, linkTo({ kind: 'page', id: op.pageId }));
      }
      case 'node.insert': {
        const what = op.componentId
          ? (catalogueComponent(after.site.themeId, op.componentId)?.name ?? op.componentId)
          : op.definitionId
            ? componentName(op.definitionId)
            : op.primitive
              ? (PRIMITIVES[op.primitive] ?? op.primitive)
              : 'an element';
        return plain(op, `Added ${what} to ${where(op.owner)}`, linkTo(op.owner, res.nodeId));
      }
      case 'node.remove':
        return plain(op, `Removed ${name(op.owner, op.nodeId)} from ${where(op.owner)}`, linkTo(op.owner));
      case 'node.removeKeepContent': {
        // The first of what took its place that the run left in place.
        const kept = ((results[i] ?? {}) as { nodeIds?: string[] }).nodeIds?.find((id) => nodeIn(after, op.owner, id));
        return plain(op, `Removed ${name(op.owner, op.nodeId)} from ${where(op.owner)}, keeping what it held`, linkTo(op.owner, kept));
      }
      case 'node.move':
        return plain(op, `Moved ${name(op.owner, op.nodeId)} on ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
      case 'node.wrap': {
        const what = op.nodeIds.length > 2 ? `${op.nodeIds.length} elements` : joinWords(op.nodeIds.map((id) => name(op.owner, id)));
        return plain(op, `Wrapped ${what} in a ${op.primitive === 'grid' ? 'Grid' : op.primitive === 'row' ? 'Row' : 'Stack'} on ${where(op.owner)}`, linkTo(op.owner, res.nodeId));
      }
      case 'node.unwrap': {
        const was = op.nodeIds.map((id) => nodeIn(before, op.owner, id));
        const what = op.nodeIds.length > 2 ? `${op.nodeIds.length} containers` : joinWords(was.map((n) => (n ? displayName(before, n) : 'a container')));
        return plain(op, `Ungrouped ${what} on ${where(op.owner)}`, linkTo(op.owner, res.nodeId));
      }
      case 'node.duplicate':
        return plain(op, `Duplicated ${name(op.owner, op.nodeId)} on ${where(op.owner)}`, linkTo(op.owner, res.nodeId));
      case 'node.copy': {
        const from = op.owner.kind === op.toOwner.kind && op.owner.id === op.toOwner.id ? '' : ` from ${where(op.owner)}`;
        return plain(op, `Copied ${name(op.owner, op.nodeId)}${from} to ${where(op.toOwner)}`, linkTo(op.toOwner, res.nodeId));
      }
      case 'node.paste': {
        const pasted = nodeIn(after, op.toOwner, res.nodeId);
        return plain(op, `Pasted ${pasted ? displayName(after, pasted) : 'an element'} into ${where(op.toOwner)}`, linkTo(op.toOwner, res.nodeId));
      }
      case 'node.rename': {
        const was = nodeIn(before, op.owner, op.nodeId);
        const old = was ? displayName(before, was) : 'an element';
        return plain(op, `Renamed ${old} to ${quoted(op.name)} on ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
      }
      case 'node.setStyle': {
        const prop = inSentence(STYLE_PROPS.find((p) => p.id === op.property)?.label ?? op.property);
        const scope = op.scope && op.scope !== 'base' ? ` (${op.scope})` : '';
        // A part of a component ("Heading") is named, so two parts' paddings are two details.
        const n = op.partId && op.partId !== 'root' ? nodeIn(after, op.owner, op.nodeId) : undefined;
        const part = n?.kind === 'instance' ? after.components[n.definitionId]?.parts[op.partId!]?.label : op.partId && op.partId !== 'root' ? op.partId : undefined;
        return styleEdit(op, `${part ? `${inSentence(part)} ` : ''}${prop}${scope}`);
      }
      case 'node.resetStyles':
        return styleEdit(op, 'styles (reset)');
      case 'instance.setVariant': {
        const n = nodeIn(after, op.owner, op.nodeId);
        const def = n?.kind === 'instance' ? after.components[n.definitionId] : undefined;
        const axis = op.axis ?? Object.entries(def?.variantAxes ?? {}).find(([, a]) => Object.hasOwn(a.options, op.variant))?.[0];
        return styleEdit(op, inSentence((axis && def?.variantAxes?.[axis]?.label) || 'style option'));
      }
      case 'node.setContent': {
        if (op.field !== 'image') return contentEdit(op, CONTENT_FIELDS[op.field] ?? op.field);
        const was = nodeIn(before, op.owner, op.nodeId);
        const now = nodeIn(after, op.owner, op.nodeId);
        const wasShown = was?.kind === 'image' ? shownImage(before, op.owner, was.image) : {};
        const nowShown = now?.kind === 'image' ? shownImage(after, op.owner, now.image) : shownImage(after, op.owner, op.value);
        return imageParts(wasShown, nowShown).forEach((p) => contentEdit(op, p));
      }
      case 'node.setBinding': {
        if (op.field === 'when' || op.field === 'unless') {
          const rule = op.field === 'when' ? 'when it shows' : 'when it hides';
          return plain(op, `${op.binding ? 'Set' : 'Cleared'} ${rule} for ${name(op.owner, op.nodeId)} in ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
        }
        const field = op.field === 'prop' ? (op.prop ?? 'property') : (CONTENT_FIELDS[op.field] ?? op.field);
        const source = op.binding && '$state' in op.binding ? 'to UI state' : 'to a property';
        const label = `${op.binding ? 'Connected' : 'Disconnected'} the ${field} of ${name(op.owner, op.nodeId)} ${op.binding ? source : 'from its property'} in ${where(op.owner)}`;
        return plain(op, label, linkTo(op.owner, op.nodeId));
      }
      case 'instance.setProp': {
        const schema = propSchema(op.owner, op.nodeId, op.prop);
        const label = inSentence(schema?.label ?? op.prop);
        if (op.itemId) {
          const fieldLabel = (f: string | undefined) => (schema?.type === 'list' && f ? (schema.fields[f]?.label ?? f) : f);
          const field = fieldLabel(op.field);
          contentEdit(op, field ? `${inSentence(field)} in ${label}` : label);
          // An email or phone link that moved with its visible text is part of the same edit.
          const followed = (results[i] as { followed?: unknown } | undefined)?.followed;
          if (Array.isArray(followed)) for (const f of followed) contentEdit(op, `${inSentence(fieldLabel(String(f))!)} in ${label}`);
          return;
        }
        if (schema?.type !== 'image') return contentEdit(op, label);
        const was = nodeIn(before, op.owner, op.nodeId);
        const now = nodeIn(after, op.owner, op.nodeId);
        const wasValue = was?.kind === 'instance' ? shownImage(before, op.owner, was.props[op.prop]) : {};
        const nowValue = shownImage(after, op.owner, now?.kind === 'instance' ? now.props[op.prop] : op.value);
        return imageParts(wasValue, nowValue, label).forEach((p) => contentEdit(op, p));
      }
      case 'instance.listInsert':
      case 'instance.listRemove':
      case 'instance.listMove': {
        const label = inSentence(propSchema(op.owner, op.nodeId, op.prop)?.label ?? op.prop);
        const what = (n: number) => (op.type === 'instance.listInsert' ? `Added ${items(n)} to the ${label}` : op.type === 'instance.listRemove' ? `Removed ${items(n)} from the ${label}` : `Reordered the ${label}`);
        return add(op, `${op.type}:${ownerKey(op.owner)}:${op.nodeId}:${op.prop}`, (_d, n) => `${what(n)} of ${name(op.owner, op.nodeId)} on ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
      }
      case 'instance.editTable': {
        const label = inSentence(propSchema(op.owner, op.nodeId, op.prop)?.label ?? op.prop);
        // Typed text is a content edit like any other; a row or column added, removed or moved is counted.
        if (op.action === 'setCell' || op.action === 'renameColumn') return contentEdit(op, op.action === 'setCell' ? `a cell in the ${label}` : `a column name in the ${label}`);
        const count = (n: number, one: string) => (n === 1 ? `a ${one}` : `${n} ${one}s`);
        const what = (n: number) => {
          switch (op.action) {
            case 'insertRow':
              return `Added ${count(n, 'row')} to the ${label}`;
            case 'insertColumn':
              return `Added ${count(n, 'column')} to the ${label}`;
            case 'removeRow':
              return `Removed ${count(n, 'row')} from the ${label}`;
            case 'removeColumn':
              return `Removed ${count(n, 'column')} from the ${label}`;
            case 'moveRow':
              return `Reordered the rows of the ${label}`;
            default:
              return `Reordered the columns of the ${label}`;
          }
        };
        return add(op, `${op.type}:${op.action}:${ownerKey(op.owner)}:${op.nodeId}:${op.prop}`, (_d, n) => `${what(n)} of ${name(op.owner, op.nodeId)} on ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
      }
      case 'token.set':
        if (op.scheme === 'dark') return plain(op, `${op.value === null ? 'Reset' : 'Changed'} the dark palette's ${quoted(tokenLabel(op.tokenId))}`);
        return plain(op, `${op.value === null ? 'Reset' : 'Changed'} the site style ${quoted(tokenLabel(op.tokenId))}`);
      case 'token.setColorScheme':
        return plain(op, op.mode === 'single' ? 'Gave the site one color palette' : `Gave the site a dark palette${op.mode === 'toggle' ? ' with a Light/Dark switch in the header' : ' that follows the visitor\'s device'}${op.regenerate ? ', made afresh' : ''}`);
      case 'token.create':
        return plain(op, `Added the site style ${quoted(op.label)}`);
      case 'token.rename':
        return plain(op, `Renamed the site style ${quoted(declaredTokens(before).find((t) => t.id === op.tokenId)?.label ?? op.tokenId)} to ${quoted(op.label)}`);
      case 'token.remove':
        return plain(op, `Removed the site style ${quoted(tokenLabel(op.tokenId))}`);
      case 'token.replace':
        return plain(op, `Replaced the site style ${quoted(tokenLabel(op.tokenId))} with ${quoted(tokenLabel(op.withTokenId))}`);
      case 'redirect.add':
      case 'redirect.update': {
        const from = typeof res.from === 'string' ? res.from : op.from;
        // Said as it was kept: the address as routes spell it, and nothing about whether anything is there yet.
        const target = op.pageId !== undefined ? quoted(after.pages[op.pageId]?.title ?? op.pageId) : op.entryId !== undefined ? quoted(findEntry(after, op.entryId)?.entry.title ?? findEntry(before, op.entryId)?.entry.title ?? op.entryId) : (res.to ?? op.to ?? '');
        return plain(op, `${op.type === 'redirect.add' ? 'Added a redirect from' : 'Changed the redirect from'} ${from} to ${target}`);
      }
      case 'redirect.remove':
        return plain(op, `Removed the redirect from ${typeof res.from === 'string' ? res.from : op.from}`);
      case 'site.update': {
        const render = (d: string[]) => `Changed the site ${d.length ? joinWords(d) : 'settings'}`;
        const fields = Object.keys(SITE_FIELDS).filter((f) => (op as Record<string, unknown>)[f] !== undefined);
        if (!fields.length) return add(op, 'site', render);
        return fields.forEach((f) => add(op, 'site', render, {}, SITE_FIELDS[f]));
      }
      case 'component.create':
        return plain(op, `Created the component ${quoted(op.name.trim())}`);
      case 'component.upsert':
        return plain(op, `${op.definitionId === undefined ? 'Built' : 'Rebuilt'} the component ${quoted(op.name.trim())}`);
      case 'component.createFromNode':
        return plain(op, `Made ${name(op.owner, op.nodeId)} on ${where(op.owner)} into the reusable component ${quoted(op.name)}`, linkTo(op.owner, res.nodeId ?? op.nodeId));
      case 'component.makeUnique':
        return plain(op, `Made ${name(op.owner, op.nodeId)} on ${where(op.owner)} a separate copy`, linkTo(op.owner, res.nodeId ?? op.nodeId));
      case 'instance.swapComponent': {
        // The design it showed just before this change, which an earlier swap in the run may have chosen.
        const was = nodeIn(before, op.owner, op.nodeId);
        const from = typeof res.from === 'string' ? res.from : was ? displayName(before, was) : name(op.owner, op.nodeId);
        const to = typeof res.definitionId === 'string' ? componentName(res.definitionId) : (op.definitionId ? componentName(op.definitionId) : (catalogueComponent(after.site.themeId, op.componentId ?? '')?.name ?? 'another design'));
        const lost = Array.isArray(res.dropped) ? res.dropped.filter((d): d is string => typeof d === 'string') : [];
        return plain(op, `Changed ${from} on ${where(op.owner)} to ${quoted(to)}${lost.length ? `, dropping ${joinWords(lost.map(quoted))}` : ''}`, linkTo(op.owner, op.nodeId));
      }
      case 'component.detachInstance':
        return plain(op, `Detached ${typeof res.label === 'string' ? res.label : name(op.owner, op.nodeId)} on ${where(op.owner)} into its own elements`, linkTo(op.owner, res.nodeId ?? op.nodeId));
      case 'component.duplicate':
        return plain(op, `Copied the ${quoted(componentName(op.definitionId))} component as ${quoted(op.name)}`);
      case 'component.rename':
        return plain(op, `Renamed the ${quoted(before.components[op.definitionId]?.name ?? 'component')} component to ${quoted(op.name)}`);
      case 'component.setInsertAs': {
        const name = quoted(before.components[op.definitionId]?.name ?? 'component');
        return plain(op, op.insertAs === null ? `Let the editor choose where the ${name} component is inserted` : `Set the ${name} component to insert as ${op.insertAs === 'section' ? 'a page section' : 'a subcomponent'}`);
      }
      case 'component.fork':
        return plain(op, `Made an editable copy of the ${quoted(componentName(op.definitionId))} component`);
      case 'component.convertToCode':
        return plain(op, `Converted ${name(op.owner, op.nodeId)} on ${where(op.owner)} to a code component`, linkTo(op.owner, res.nodeId ?? op.nodeId));
      case 'component.createCode':
        return plain(op, `Created the code component ${quoted(op.name)}`);
      case 'component.updateSource': {
        const renamed = op.renames?.length ? ` and renamed ${joinWords(op.renames.map((r) => `${quoted(r.from)} to ${quoted(r.to)}`))}` : '';
        return plain(op, `Updated the code of the ${quoted(componentName(op.definitionId))} component${renamed}`);
      }
      case 'component.remove':
        return plain(op, `Removed the ${quoted(before.components[op.definitionId]?.name ?? 'component')} component`);
      case 'component.import':
        return plain(op, `Imported the ${quoted(res.definitionId ? componentName(res.definitionId) : 'component')} component`);
      case 'component.setPropSchema':
      case 'component.removePropSchema': {
        const had = before.components[op.definitionId]?.properties[op.prop];
        const label = (op.type === 'component.setPropSchema' ? (op.schema.label as string | undefined) : undefined) ?? had?.label ?? op.prop;
        const how = op.type === 'component.removePropSchema' ? 'Removed' : had ? 'Changed' : 'Added';
        return plain(op, `${how} the property ${quoted(label)} ${how === 'Removed' ? 'from' : 'of'} the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'component.orderProperties':
        return plain(op, `Reordered the properties of the ${quoted(componentName(op.definitionId))} component`);
      case 'component.setPropDefault': {
        const label = before.components[op.definitionId]?.properties[op.prop]?.label ?? op.prop;
        return plain(op, `Changed the default ${quoted(label)} of the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'component.setPart':
      case 'component.removePart': {
        const had = before.components[op.definitionId]?.parts[op.partId];
        const label = op.type === 'component.setPart' ? op.label : (had?.label ?? op.partId);
        const how = op.type === 'component.removePart' ? 'Removed' : had ? 'Changed' : 'Added';
        return plain(op, `${how} the part ${quoted(label)} ${how === 'Removed' ? 'from' : 'of'} the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'component.setVariant':
      case 'component.removeVariant': {
        const axes = before.components[op.definitionId]?.variantAxes ?? {};
        const had = Object.values(axes).find((a) => Object.hasOwn(a.options, op.variant))?.options[op.variant];
        const label = op.type === 'component.setVariant' ? op.label : (had?.label ?? op.variant);
        const how = op.type === 'component.removeVariant' ? 'Removed' : had ? 'Changed' : 'Added';
        return plain(op, `${how} the option ${quoted(label)} ${how === 'Removed' ? 'from' : 'of'} the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'component.setState':
      case 'component.removeState': {
        const had = before.components[op.definitionId]?.state?.[op.state];
        const label = (op.type === 'component.setState' ? op.schema.label : undefined) || had?.label || op.state;
        const how = op.type === 'component.removeState' ? 'Removed' : had ? 'Changed' : 'Added';
        return plain(op, `${how} the UI state ${quoted(label)} ${how === 'Removed' ? 'from' : 'of'} the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'node.setStateAction':
        return plain(op, `${op.action ? 'Set' : 'Cleared'} what ${name(op.owner, op.nodeId)} does to UI state in ${where(op.owner)}`, linkTo(op.owner, op.nodeId));
      case 'component.setSlot':
      case 'component.removeSlot': {
        const had = before.components[op.definitionId]?.slots?.[op.slot];
        const label = op.type === 'component.setSlot' ? op.label : (had?.label ?? op.slot);
        const how = op.type === 'component.removeSlot' ? 'Removed' : had ? 'Changed' : 'Added';
        return plain(op, `${how} the content area ${quoted(label)} ${how === 'Removed' ? 'from' : 'of'} the ${quoted(componentName(op.definitionId))} component`);
      }
      case 'component.containerToSlot': {
        const kept = op.keep === 'placements' ? ', moving what it held into each placement' : '';
        return plain(op, `Turned ${name({ kind: 'component', id: op.definitionId }, op.nodeId)} into the content area ${quoted(op.label)} of the ${quoted(componentName(op.definitionId))} component${kept}`);
      }
      case 'theme.apply': {
        let theme = op.themeId;
        try {
          theme = getTheme(op.themeId).name;
        } catch {
          /* an unknown theme keeps its ID */
        }
        return plain(op, `Applied the ${quoted(theme)} theme`);
      }
      case 'theme.refresh': {
        // The components it updated, by name: one the request needed, or every one Project health could.
        const updated = (results[i] as { updated?: unknown } | undefined)?.updated;
        const names = Array.isArray(updated) ? updated.filter((id): id is string => typeof id === 'string').map((id) => quoted(componentName(id))) : [];
        if (!names.length) return plain(op, 'Updated components to the latest theme version');
        if (names.length > 3) return plain(op, `Updated ${names.length} components to the theme's newer version`);
        const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
        return plain(op, `Updated the ${list} component${names.length === 1 ? '' : 's'} to the theme's newer version`);
      }
      case 'asset.add':
        return plain(op, `Added the ${op.asset.kind === 'font' ? 'font' : 'image'} ${quoted(op.asset.name)} to the library`);
      case 'asset.update':
        return plain(op, `Changed the details of ${quoted(assetName(op.assetId))} in the library`);
      case 'asset.remove':
        return plain(op, `Removed ${quoted(assetName(op.assetId))} from the library`);
      case 'asset.replace': {
        // Uses whose alt text was the author's own, or went with no suggestion to replace it, are worth a look: those
        // the run has not changed or removed since.
        const review = (results[i] as { altReview?: unknown } | undefined)?.altReview;
        const n = Array.isArray(review) ? altStillToCheck(after, op.withAssetId, review as AltReview[]).length : 0;
        const check = n ? `; check the alt text in ${n === 1 ? 'one place' : `${n} places`}` : '';
        const where = op.uses ? `in ${op.uses.length === 1 ? 'one chosen place' : `${op.uses.length} chosen places`}` : 'wherever it was used';
        return plain(op, `Replaced ${quoted(assetName(op.assetId))} with ${quoted(assetName(op.withAssetId))} ${where}${check}`);
      }
      case 'asset.relink':
        return plain(op, `Gave ${quoted(assetName(op.assetId))} a new image file`);
      case 'collection.create':
        return plain(op, `Added the ${quoted(after.collections[op.collectionId]?.settings.name ?? op.collectionId)} collection`);
      case 'collection.update':
        return plain(op, `Changed the settings of the ${quoted(collectionName(op.collectionId))} collection`);
      case 'collection.remove':
        return plain(op, `Deleted the ${quoted(before.collections[op.collectionId]?.settings.name ?? op.collectionId)} collection and its entries`);
      case 'collection.createTerm':
        return plain(op, `Added ${quoted(op.label.trim())} to the ${termGrouping(op.collectionId, op.taxonomyId)}`);
      case 'collection.renameTerm':
        return plain(op, `Renamed ${quoted(termLabel(op.collectionId, op.taxonomyId, op.termId))} to ${quoted(op.label.trim())} in the ${termGrouping(op.collectionId, op.taxonomyId)}`);
      case 'collection.removeTerm':
        return plain(op, `Deleted ${quoted(termLabel(op.collectionId, op.taxonomyId, op.termId))} from the ${termGrouping(op.collectionId, op.taxonomyId)}`);
      case 'entry.create':
        return plain(op, `Added the entry ${quoted(op.title)} to ${quoted(collectionName(op.collectionId))}`);
      case 'entry.update':
        return plain(op, `Changed the entry ${quoted(entryTitle(op.collectionId, op.entryId))}`);
      case 'entry.reorder':
        return plain(op, `Reordered the entries of ${quoted(collectionName(op.collectionId))}`);
      case 'entry.remove':
        return plain(op, `Deleted the entry ${quoted(before.collections[op.collectionId]?.entries[op.entryId]?.title ?? op.entryId)}`);
      case 'brief.update':
        // Never what it says: the brief is the author's own.
        return plain(op, 'Changed the project brief');
      default: {
        // Every operation type has a sentence; a new one fails the type check here until it gets one.
        const unknown: never = op;
        return plain(unknown, 'Made a change');
      }
    }
  });
  return [...drafts.values()].map((d) => ({ label: d.render(d.details, d.count), ...d.link, operations: [...d.operations] }));
}

// ---------------------------------------------------------------------------
// Checks: the final result of each check the run made, said once
// ---------------------------------------------------------------------------

export type Viewport = 'phone' | 'tablet' | 'desktop';

/** What the preview bridge reports about the page's images (see bridge.client.js). */
interface ImageSummary {
  total: number;
  loaded: number;
  failed: number;
  unverified: number;
  failedFiles?: string[];
}

interface InspectionContent {
  pageId?: string;
  viewport?: string;
  report?: { issues?: Array<{ kind: string; message?: string }>; images?: ImageSummary; documentWidth?: number; viewportWidth?: number; checks?: Partial<InspectionChecks>; runtimeErrors?: unknown[] };
}

/** How each readability check's failures read on the result card, one and many. */
const READABILITY_ROWS: Array<[keyof InspectionChecks, string, string]> = [
  ['contrast', 'text with low contrast', 'text elements with low contrast'],
  ['overlaps', 'overlapping boxes', 'overlapping boxes'],
  ['clippedText', 'text cut off by its box', 'boxes that cut off text'],
  // Said for a site owner: what a tap target under 44px is like to use.
  ['tapTargets', 'a link or button too small to tap easily', 'links or buttons too small to tap easily']
];

/**
 * The readability checks (contrast, overlaps, cut-off text, tap targets) as at most two rows: what failed, and what
 * could not be measured without pixels; or one pass once every check that applies measured something. Reports
 * from before these checks have none.
 */
function readabilityChecks(checks: Partial<InspectionChecks> | undefined, at: string): ChatCheck[] {
  if (!checks || typeof checks !== 'object') return [];
  const count = (c: CheckCount | undefined, k: 'checked' | 'failed' | 'unverified') => (c && typeof c[k] === 'number' ? c[k] : 0);
  const failed = READABILITY_ROWS.flatMap(([key, one, many]) => {
    const n = count(checks[key], 'failed');
    return n ? [n === 1 ? one : `${n} ${many}`] : [];
  });
  const out: ChatCheck[] = [];
  if (failed.length) out.push({ status: 'issue', text: `Found ${joinWords(failed)} ${at}.` });
  const unverified = count(checks.contrast, 'unverified');
  if (unverified) out.push({ status: 'unverified', text: `Couldn't confirm the contrast of ${unverified === 1 ? 'text' : `${unverified} text elements`} over images or mixed backgrounds ${at}.` });
  // A page too large (or odd) to measure in full is never vouched for.
  if (READABILITY_ROWS.some(([key]) => checks[key]?.incomplete)) out.push({ status: 'unverified', text: `Couldn't check all of the page's readability ${at}.` });
  if (!out.length && READABILITY_ROWS.some(([key]) => count(checks[key], 'checked') > 0)) {
    const applied = READABILITY_ROWS.filter(([key]) => checks[key] && !checks[key]!.skipped).map(([key]) => ({ contrast: 'text contrast', overlaps: 'overlaps', clippedText: 'cut-off text', tapTargets: 'tap targets' })[key]);
    out.push({ status: 'pass', text: `No problems with ${joinWords(applied)} ${at}.` });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The layout and image checks for one inspection of one page at one width. */
export function inspectionChecks(ok: boolean, content: unknown, onPage = ''): ChatCheck[] {
  const c = (content ?? {}) as InspectionContent;
  const at = `at ${c.viewport ?? 'that'} width${onPage}`;
  if (!ok || !c.report) return [{ status: 'unverified', text: `Couldn't check the layout ${at}.` }];
  const issues = c.report.issues ?? [];
  const kinds = new Set(issues.map((i) => i.kind));
  // The widths are measured whatever the issue list kept: a capped list cannot turn overflow into a pass.
  const { documentWidth, viewportWidth } = c.report;
  const wide = typeof documentWidth === 'number' && typeof viewportWidth === 'number' && documentWidth > viewportWidth + 1;
  const out: ChatCheck[] = [
    wide || kinds.has('horizontal-overflow') || kinds.has('element-overflow')
      ? { status: 'issue', text: `Content is wider than the screen ${at}.` }
      : kinds.has('text-overflow')
        ? { status: 'issue', text: `Some text overflows its box ${at}.` }
        : { status: 'pass', text: `Fits the screen ${at}.` }
  ];
  // Older bridges report only broken images, as issues; newer ones count every image.
  const images: ImageSummary = c.report.images ?? { total: 0, loaded: 0, failed: issues.filter((i) => i.kind === 'broken-image').length, unverified: 0 };
  const files = (images.failedFiles ?? []).slice(0, 3);
  if (images.failed > 0) {
    const more = images.unverified ? ` ${plural(images.unverified, 'other')} could not be checked.` : '';
    out.push({ status: 'issue', text: `${images.failed === 1 ? 'An image' : `${images.failed} images`} failed to load ${at}${files.length ? ` (${files.join(', ')})` : ''}.${more}` });
  } else if (images.unverified > 0) {
    out.push({ status: 'unverified', text: `Couldn't confirm that ${images.unverified === 1 ? 'an image' : `${images.unverified} images`} loaded ${at}.` });
  } else if (images.total > 0) {
    out.push({ status: 'pass', text: images.total === 1 ? `The image loads ${at}.` : `All ${images.total} images load ${at}.` });
  }
  // A script that failed in the page is a problem whatever the layout measured.
  const errors = Array.isArray(c.report.runtimeErrors) ? c.report.runtimeErrors.map(String).filter((e) => e.trim()) : [];
  if (errors.length) {
    const first = errors[0].trim().replace(/\.$/, '');
    out.push({ status: 'issue', text: `Found ${errors.length === 1 ? 'a script error' : `${errors.length} script errors`} ${at} (${first.length > 120 ? `${first.slice(0, 119)}…` : first}).` });
  }
  out.push(...readabilityChecks(c.report.checks, at));
  return out;
}

/**
 * The pages an edit can change the look of: the page it is on, or every page for what they share (header,
 * footer, components, site styles and settings, the theme, the image library). A new page changes no other, unless
 * it is an article, which News lists elsewhere show.
 */
export function pagesTouched(ops: EditOperation[], state?: ProjectState): Set<string> | 'all' {
  // Whether a page is (or, without the project to tell, may be) an article, which News lists elsewhere show.
  const article = (pageId: string) => !state || !!pageArticle(Object.hasOwn(state.pages, pageId) ? state.pages[pageId] : undefined);
  const pages = new Set<string>();
  for (const op of ops) {
    if (op.type === 'node.copy' || op.type === 'node.paste') {
      // The copy lands in toOwner; the original stays as it was.
      if (op.toOwner.kind !== 'page') return 'all';
      pages.add(op.toOwner.id);
    } else if ('owner' in op) {
      if (op.owner.kind !== 'page') return 'all';
      pages.add(op.owner.id);
    } else if (op.type === 'page.create') {
      // A new article joins the News lists on other pages.
      if (op.addToNavigation || op.starter === 'article' || op.articleDate !== undefined) return 'all';
    } else if (op.type === 'page.setHome') {
      // Header and footer links change destination on every page, and a page can be styled by where its links go.
      return 'all';
    } else if (op.type === 'page.update' && op.route !== undefined) {
      // A new address moves the pages inside the page too, and changes where links to them lead on every page.
      return 'all';
    } else if (op.type === 'page.remove' || (op.type === 'page.update' && (op.title !== undefined || op.description !== undefined || op.socialImage !== undefined))) {
      // Page lists elsewhere show a page's title, description and sharing image, and drop its card when it goes.
      return 'all';
    } else if (op.type === 'page.update' && (['articleDate', 'byline', 'excerpt', 'newsHidden', 'article'] as const).some((k) => op[k] !== undefined)) {
      // News lists elsewhere show an article's date, byline and excerpt, and only while it is listed.
      return 'all';
    } else if ((op.type === 'page.update' && op.draft !== undefined) || op.type === 'page.duplicate') {
      // Publishing or drafting an article, or copying one, changes the News lists elsewhere.
      if (article(op.pageId)) return 'all';
      if (op.type === 'page.update') pages.add(op.pageId);
    } else if (op.type === 'page.update') pages.add(op.pageId);
    else if (op.type !== 'page.reorder') return 'all';
  }
  return pages;
}

/**
 * Inspections made during a run, keyed by page and width: a later check of the same page at the same width
 * replaces the earlier one, so the card shows each check's final state once. A check made before a later edit
 * to its page no longer describes the final page, so it is reported as not confirmed.
 */
export class InspectionLog {
  private latest = new Map<string, { pageId: string; ok: boolean; content: unknown; stale: boolean }>();
  /**
   * Component checks (inspect_component), by component and sample, each window of cases kept by its offset;
   * `pageId`: the page of the placement whose content was the sample.
   */
  private components = new Map<string, { windows: Map<number, { ok: boolean; content: unknown; stale: boolean }>; pageId?: string }>();

  record(pageId: string, viewport: string, ok: boolean, content: unknown) {
    // Setting an existing key keeps the order of first inspection while the result is the latest one.
    this.latest.set(`${pageId}\n${viewport}`, { pageId, ok, content, stale: false });
  }

  /** A check of one component on its own; `key` names the component and its sample, `offset` the window of its cases. */
  recordComponent(key: string, offset: number, ok: boolean, content: unknown) {
    const owner = (content as { placement?: { owner?: { kind?: unknown; id?: unknown } } } | null)?.placement?.owner;
    let e = this.components.get(key);
    if (!e) this.components.set(key, (e = { windows: new Map(), ...(owner?.kind === 'page' && typeof owner.id === 'string' ? { pageId: owner.id } : {}) }));
    e.windows.set(offset, { ok, content, stale: false });
    // A sweep that now has fewer cases (a variant removed) leaves no window past its end.
    const total = ok ? sweepTotal(offset, content) : undefined;
    if (total !== undefined) for (const at of [...e.windows.keys()]) if (at > offset && at >= total) e.windows.delete(at);
  }

  /** An edit landed on these pages (or on what every page shares) after their checks ran. */
  invalidate(pages: Set<string> | 'all') {
    for (const e of this.latest.values()) if (pages === 'all' || pages.has(e.pageId)) e.stale = true;
    // A component's design, the site's styles and the theme reach every page; an edit of one page's content reaches
    // only a check whose sample was a placement on it.
    for (const e of this.components.values()) if (pages === 'all' || (e.pageId && pages.has(e.pageId))) for (const w of e.windows.values()) w.stale = true;
  }

  /** Each check names its page, so a check is never read as being about another page the run changed. */
  checks(state: ProjectState): ChatCheck[] {
    const stale = (rows: ChatCheck[]) => rows.map((r): ChatCheck => ({ status: 'unverified', text: `${r.text.replace(/\.$/, '')}, before later changes.` }));
    const pages = [...this.latest.values()].flatMap((e) => {
      const page = Object.hasOwn(state.pages, e.pageId) ? state.pages[e.pageId] : undefined;
      // A page the run removed after checking it has nothing left to report on; an unknown page has no title.
      if (!page && !e.pageId.startsWith('?')) return [];
      const rows = inspectionChecks(e.ok, e.content, page ? ` on ${page.title}` : '');
      return e.stale ? stale(rows) : rows;
    });
    const components = [...this.components.values()].flatMap((e) => {
      const windows = [...e.windows].sort((a, b) => a[0] - b[0]).map(([, w]) => w);
      const row = componentCheck(windows);
      return windows.some((w) => w.stale) ? stale([row]) : [row];
    });
    return [...pages, ...components];
  }
}

/** Where a component check's window of cases ends, and how many cases its sweep has, from what it reported. */
const sweepEnd = (offset: number, c: ComponentContent) => (c.next ? Number(c.next.offset) || 0 : offset + (Array.isArray(c.cases) ? c.cases.length : 0));
const sweepTotal = (offset: number, content: unknown) => {
  const c = (content ?? {}) as ComponentContent;
  return c.incomplete ? undefined : sweepEnd(offset, c) + (Number(c.next?.remaining) || 0);
};

type ComponentContent = { offset?: unknown; cases?: unknown[]; next?: { offset?: unknown; remaining?: unknown }; name?: unknown; findings?: unknown[]; omittedFindings?: unknown; runtimeErrors?: unknown[]; omittedRuntimeErrors?: unknown; incomplete?: unknown; unverifiedContrast?: unknown };

/**
 * One component's checks as the result card lists them, over every window of its cases (in order): problems found
 * in any, part of it not run (a window that failed or stopped short, or cases left after the last), or none found.
 */
export function componentCheck(windows: Array<{ ok: boolean; content: unknown }>): ChatCheck {
  const contents = windows.map((w) => (w.content ?? {}) as ComponentContent);
  const named = contents.map((c) => c.name).find((n): n is string => typeof n === 'string' && !!n);
  const name = named ?? 'the component';
  const problems = contents.reduce((n, c, i) => n + (windows[i].ok ? (c.findings?.length ?? 0) + (Number(c.omittedFindings) || 0) + (c.runtimeErrors?.length ?? 0) + (Number(c.omittedRuntimeErrors) || 0) : 0), 0);
  if (problems) return { status: 'issue', text: `${name} has ${plural(problems, 'problem')} in its variants or with long or empty content.` };
  if (!windows.some((w) => w.ok)) return { status: 'unverified', text: `Couldn't check ${named ?? 'a component'} in its variants and with long and empty content.` };
  // Every case from the first to the last measured: no window failed or stopped short, none missing between them.
  let covered = 0;
  for (const [i, c] of contents.entries()) covered = windows[i].ok && (Number(c.offset) || 0) <= covered ? Math.max(covered, sweepEnd(Number(c.offset) || 0, c)) : -1;
  if (covered < 0 || windows.some((w) => !w.ok) || contents.some((c) => c.incomplete) || contents.at(-1)?.next) return { status: 'unverified', text: `Only part of ${name} could be checked in its variants and with long and empty content.` };
  const unverified = contents.reduce((n, c) => n + (Number(c.unverifiedContrast) || 0), 0);
  if (unverified) return { status: 'unverified', text: `${name} has no layout problems in its variants or with long and empty content, but the contrast of ${plural(unverified, 'text')} over pictures or effects could not be measured.` };
  return { status: 'pass', text: `${name} has no layout or readability problems in its variants or with long and empty content.` };
}
