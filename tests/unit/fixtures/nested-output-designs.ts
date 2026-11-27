/**
 * An FAQ and contact details built in the editor, for the tests of the structured data a page's FAQ and contact
 * sections give it (tests/unit/nested-output.test.ts). The generator reads that from a design's tree: the question and
 * answer of each item of an FAQ, and the value link of each contact method. These are the smallest designs of Foundation's
 * two contracts with those nodes, their properties those of the loaded release's sections, so a starter's placements
 * show them as they are.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import { getTheme } from '@catalogue/index';
import { item, prop } from '@catalogue/dsl';
import { foundationDesign } from './packs';

const released = (componentId: string) => getTheme('foundation').components.find((c) => c.componentId === componentId)!;

/** An FAQ whose questions open from a summary: each item a `details` holding its question, then its answer. */
export function editorFaq(): ComponentDefinition {
  const { properties, variantAxes } = structuredClone(released('faq.list'));
  return foundationDesign({
    componentId: 'faq.list',
    name: 'FAQ',
    category: 'conversion',
    properties,
    variantAxes: { tone: { ...variantAxes!.tone, prop: undefined } },
    parts: {
      root: { nodeId: 'root', label: 'Section' },
      item: { nodeId: 'item', label: 'Question' },
      question: { nodeId: 'question', label: 'Question text' },
      answer: { nodeId: 'answer', label: 'Answer' }
    },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('list', 'div', { name: 'Questions' }, [
          b.repeat('questions', 'items', [b.el('item', 'details', { name: 'Question' }, [b.el('summary', 'summary', { name: 'Summary' }, [b.text('question', 'span', item('question'), { name: 'Question text' })]), b.text('answer', 'p', item('answer'), { name: 'Answer' })])])
        ])
      ])
  });
}

/** Contact details: each method an icon beside its label and its value, a link to it. */
export function editorContactDetails(): ComponentDefinition {
  const { properties, variantAxes } = structuredClone(released('contact.details'));
  return foundationDesign({
    componentId: 'contact.details',
    name: 'Contact details',
    category: 'conversion',
    properties,
    variantAxes: { tone: { ...variantAxes!.tone, prop: undefined } },
    parts: { root: { nodeId: 'root', label: 'Section' }, list: { nodeId: 'list', label: 'Contact list' }, method: { nodeId: 'method', label: 'Contact method' } },
    build: (b) =>
      b.el('root', 'section', { name: 'Section' }, [
        b.text('heading', prop('headingLevel'), prop('heading'), { name: 'Heading', when: prop('heading') }),
        b.el('list', 'ul', { name: 'Contact list' }, [
          b.repeat('methods', 'items', [b.el('method', 'li', { name: 'Contact method' }, [b.icon('method-icon', item('icon')), b.text('method-label', 'span', item('label')), b.link('method-value', item('link'), item('value'), 'plain', { name: 'Value' })])])
        ])
      ])
  });
}

/**
 * The project with Foundation's FAQ and contact details as designs built in the editor, in place of the release's
 * code (installed now, whether or not the project had them).
 */
export function withEditorStructure(state: ProjectState): ProjectState {
  for (const def of [editorFaq(), editorContactDetails()]) state.components[def.id] = def;
  return state;
}
