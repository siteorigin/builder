/**
 * A theme for the Find and Replace tests (find-content.test.ts): Foundation's sections under another theme's name, with
 * its Contact details and Footer drawn as designs built in the editor, on the very properties the release declares.
 * Foundation's are code components whose words Builder leaves to their inspector (see the Release gap tests), so what
 * Find and Replace does with the starter's contact details is tried on these.
 */
import type { ComponentDefinition } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { item, prop, type ComponentSpec } from '@catalogue/dsl';
import { registerBeside, testPack } from './packs';

export const FIND_THEME = 'find-content-theme';

/** A design with the release component's identity and properties, and parts and a tree of its own. */
function like(release: ComponentDefinition, parts: ComponentSpec['parts'], build: ComponentSpec['build']): ComponentSpec {
  const { componentId, name, description, category, tags, icon } = release;
  return { componentId, name, description, category, tags: [...tags], icon: icon ?? 'square', properties: structuredClone(release.properties), parts, build };
}

/** Contact details: the heading over the contact methods, each its label and its value linked, then the action. */
const details = (release: ComponentDefinition) =>
  like(
    release,
    { root: { nodeId: 'root', label: 'Section' }, heading: { nodeId: 'heading', label: 'Heading' }, method: { nodeId: 'method', label: 'Contact method' } },
    (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('eyebrow', 'p', prop('eyebrow'), { name: 'Eyebrow', when: prop('eyebrow') }),
        b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.text('lead', 'p', prop('lead'), { name: 'Supporting text', when: prop('lead') }),
        b.el('list', 'ul', { name: 'Contact list' }, [
          b.repeat('methods', 'items', [b.el('method', 'li', { name: 'Contact method' }, [b.text('method-label', 'p', item('label'), { name: 'Label' }), b.link('method-value', item('link'), item('value'), 'link', { name: 'Value' })])])
        ]),
        b.link('action', prop('actionLink'), prop('actionLabel'), 'primary', { name: 'Action', when: prop('actionLabel') })
      ])
  );

/** The footer: the site's name and tagline, its links, its contact details and the copyright line. */
const footer = (release: ComponentDefinition) =>
  like(release, { root: { nodeId: 'root', label: 'Footer' }, brand: { nodeId: 'brand', label: 'Site name' } }, (b) =>
    b.el('root', 'footer', { name: 'Footer' }, [
      b.text('brand', 'p', prop('siteName'), { name: 'Site name' }),
      b.text('tagline', 'p', prop('tagline'), { name: 'Tagline', when: prop('tagline') }),
      b.el('nav', 'nav', { name: 'Links' }, [
        b.text('links-heading', 'h2', prop('linksHeading'), { name: 'Links heading', when: prop('linksHeading') }),
        b.repeat('link-items', 'links', [b.link('link', item('link'), item('label'), 'link', { name: 'Link' })])
      ]),
      b.el('contact', 'div', { name: 'Contact' }, [
        b.text('contact-heading', 'h2', prop('contactHeading'), { name: 'Contact heading', when: prop('contactHeading') }),
        b.repeat('contact-items', 'contact', [b.link('contact-detail', item('link'), item('label'), 'link', { name: 'Contact detail' })])
      ]),
      b.text('copyright', 'p', prop('copyright'), { name: 'Copyright' })
    ])
  );

/** Register the theme beside the releases (restorePacks takes it away again). */
export function registerFindTheme() {
  const foundation = getTheme('foundation');
  const release = (id: string) => foundation.components.find((c) => c.componentId === id)!;
  const author = testPack(FIND_THEME);
  const designed = ['contact.details', 'shell.footer'];
  const others = foundation.components.filter((c) => !designed.includes(c.componentId)).map((c) => author.adopt(c));
  registerBeside(author.define([...others, author.managed(details(release('contact.details'))), author.managed(footer(release('shell.footer')))]));
}
