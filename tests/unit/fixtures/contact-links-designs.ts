/**
 * Managed stand-ins for Foundation's Contact details and footer, for the tests of contact links that follow their
 * visible text: the same definition IDs and properties as the release's (so its default items, and every stored item a
 * starter places, stay valid), with a tree whose repeated link shows one item field and opens another, as the managed
 * Foundation drew them. The release's are Svelte code components, whose links the editor cannot pair with their text
 * (the Release gap tests in contact-links.test.ts).
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { item, prop } from '@catalogue/dsl';
import { foundationDesign } from './packs';

/** The release's definition with its tree drawn as a managed design, under the same ID and properties. */
function managedLike(release: ComponentDefinition, build: Parameters<typeof foundationDesign>[0]['build']): ComponentDefinition {
  const def = foundationDesign({ componentId: release.componentId, name: release.name, properties: structuredClone(release.properties), parts: {}, build });
  if (def.id !== release.id) throw new Error(`The managed ${release.componentId} is ${def.id}, not the release's ${release.id}.`);
  return def;
}

/** Contact details: a heading, then a method per item whose value is a link that opens the item's link. */
export const managedContactDetails = (release: ComponentDefinition): ComponentDefinition =>
  managedLike(release, (b) =>
    b.el('root', 'section', { name: 'Section' }, [
      b.text('heading', 'h2', prop('heading'), { name: 'Heading' }),
      b.el('list', 'ul', { name: 'Contact list' }, [
        b.repeat('methods', 'items', [
          b.el('method', 'li', { name: 'Contact method' }, [
            b.text('method-label', 'span', item('label'), { name: 'Label' }),
            b.link('method-value', item('link'), item('value'), 'plain', { name: 'Value' })
          ])
        ])
      ])
    ])
  );

/** The footer: the site's name, then a contact link per item, which shows its label and opens its destination. */
export const managedFooter = (release: ComponentDefinition): ComponentDefinition =>
  managedLike(release, (b) =>
    b.el('root', 'footer', { name: 'Footer' }, [
      b.text('site-name', 'p', prop('siteName'), { name: 'Site name' }),
      b.el('contact-list', 'ul', { name: 'Contact' }, [b.repeat('contact-items', 'contact', [b.el('contact-item', 'li', { name: 'Contact detail' }, [b.link('contact-link', item('link'), item('label'), 'plain', { name: 'Link' })])])])
    ])
  );

/** The project with the release's Contact details and footer, wherever it has them, drawn as the managed designs above. */
export function withManagedContact(state: ProjectState): ProjectState {
  const components = { ...state.components };
  for (const [id, def] of Object.entries(components)) {
    if (def.componentId === 'contact.details' && def.kind === 'code') components[id] = managedContactDetails(def);
    if (def.componentId === 'shell.footer' && def.kind === 'code') components[id] = managedFooter(def);
  }
  return { ...state, components };
}
