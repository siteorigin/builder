/**
 * The contact form's service settings (issue #18): the inspector shows only the setting the selected service needs,
 * with how to get it and why the form cannot send without it, and keeps the other services' values for a switch back.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ComponentDefinition, InstanceNode, ProjectState } from '@shared/types';
import { createStarterState } from '@catalogue/starters';
import { contactForm, FORM_PROVIDERS, FORM_SERVICES, formConnectionProblem, formServiceSetup } from '@catalogue/foundation/form';
import { installComponent, makeInstance } from '@engine/install';
import { applyOperations } from '@engine/apply';
import { validateState } from '@engine/validate';

/** The contact form as a v1 project saved it, before the form refused clashing field names. */
const LEGACY: ComponentDefinition = JSON.parse(readFileSync(join(__dirname, 'fixtures/v1-project/siteorigin/components/foundation.contact.form/component.json'), 'utf8'));
const fresh = () => createStarterState('business', 'Test Studio', false);
const home = (s: ProjectState) => s.pages[s.site.homePageId];

function withForm(props: Record<string, unknown> = {}): { s: ProjectState; node: InstanceNode; def: ComponentDefinition } {
  const s = fresh();
  const def = s.components[installComponent(s, 'contact.form')];
  const node = makeInstance(def, props);
  home(s).nodes[node.id] = node;
  home(s).rootIds.push(node.id);
  return { s, node, def };
}

const unconnected = (s: ProjectState) => validateState(s).filter((d) => d.code === 'FORM_UNCONNECTED').map((d) => d.message);

describe('contact form service settings', () => {
  it('has setup text for every service the form offers', () => {
    expect(Object.keys(FORM_SERVICES).sort()).toEqual(FORM_PROVIDERS.map(([v]) => v).sort());
    for (const { prop } of Object.values(FORM_SERVICES)) expect(contactForm.properties[prop]?.type).toBe('string');
  });

  it('shows only the selected service’s setting, with how to get it', () => {
    // A new form stores nothing for its service: the schema default decides, as in the export.
    expect(formServiceSetup(contactForm, {})).toEqual({
      prop: 'endpoint',
      hidden: ['accessKey', 'formName'],
      setup: FORM_SERVICES.endpoint.setup,
      problem: FORM_SERVICES.endpoint.missing
    });
    const web3 = formServiceSetup(contactForm, { provider: 'web3forms' })!;
    expect([web3.prop, web3.hidden, web3.problem]).toEqual(['accessKey', ['endpoint', 'formName'], FORM_SERVICES.web3forms.missing]);
    expect(web3.setup).toMatch(/web3forms\.com/);
    // Netlify's form name has a default, so a new Netlify form is connected.
    const netlify = formServiceSetup(contactForm, { provider: 'netlify' })!;
    expect([netlify.prop, netlify.hidden, netlify.problem]).toEqual(['formName', ['endpoint', 'accessKey'], undefined]);
    expect(netlify.setup).toMatch(/form detection/);
  });

  it('says what each service is missing until the form can send', () => {
    const problem = (props: Record<string, unknown>) => formServiceSetup(contactForm, props)?.problem;
    expect(problem({ provider: 'endpoint', endpoint: '   ' })).toBe(FORM_SERVICES.endpoint.missing);
    expect(problem({ provider: 'endpoint', endpoint: 'http://insecure.example/f' })).toBe(FORM_SERVICES.endpoint.invalid);
    expect(problem({ provider: 'endpoint', endpoint: 'formspree.io/f/abc' })).toBe(FORM_SERVICES.endpoint.invalid);
    expect(problem({ provider: 'endpoint', endpoint: 'https://formspree.io/f/abc123' })).toBeUndefined();
    expect(problem({ provider: 'web3forms', accessKey: '  ' })).toBe(FORM_SERVICES.web3forms.missing);
    expect(problem({ provider: 'web3forms', accessKey: 'abc-123' })).toBeUndefined();
    expect(problem({ provider: 'netlify', formName: ' ' })).toBe(FORM_SERVICES.netlify.missing);
    // A stored null is exported as the default name, so it connects the form.
    expect(problem({ provider: 'netlify', formName: null })).toBeUndefined();
    // Another service's setting never connects this one.
    expect(problem({ provider: 'web3forms', endpoint: 'https://formspree.io/f/abc123' })).toBe(FORM_SERVICES.web3forms.missing);
  });

  it('shows every setting when the settings cannot be sorted by service', () => {
    expect(formServiceSetup(contactForm, { provider: 'mailchimp' })).toBeUndefined();
    expect(formServiceSetup(contactForm, { provider: { $prop: 'service' } })).toBeUndefined();
    const { accessKey: _, ...rest } = contactForm.properties;
    expect(formServiceSetup({ ...contactForm, properties: rest }, {})).toBeUndefined();
    // Project code that no longer reads the settings the theme's way may use them for something else.
    const edited = contactForm.source!.replace("provider === 'web3forms' ? 'https://api.web3forms.com/submit'", "provider === 'web3forms' ? 'https://relay.example/submit'");
    expect(edited).not.toBe(contactForm.source);
    expect(formServiceSetup({ ...contactForm, source: edited }, {})).toBeUndefined();
    // A setting bound from outside is only known where the form is placed: no problem is claimed for it.
    expect(formServiceSetup(contactForm, { provider: 'web3forms', accessKey: { $prop: 'key' } })).toMatchObject({ prop: 'accessKey', problem: undefined });
  });

  it('sorts the settings of forms saved by earlier versions and of project copies', () => {
    expect(formServiceSetup(LEGACY, { provider: 'web3forms' })).toMatchObject({ prop: 'accessKey', hidden: ['endpoint', 'formName'] });
    const { s, node } = withForm({ provider: 'web3forms' });
    const owner = { kind: 'page' as const, id: s.site.homePageId };
    const after = applyOperations(s, [{ type: 'component.makeUnique', owner, nodeId: node.id }]).state;
    const copy = after.components[(home(after).nodes[node.id] as InstanceNode).definitionId];
    expect(copy.owner).toBe('project');
    expect(copy.componentId).not.toBe('contact.form');
    expect(formServiceSetup(copy, { provider: 'web3forms' })).toMatchObject({ prop: 'accessKey', problem: FORM_SERVICES.web3forms.missing });
  });

  it('keeps each service’s setting when the author switches away and back', () => {
    const { s: start, node } = withForm();
    const owner = { kind: 'page' as const, id: start.site.homePageId };
    const set = (s: ProjectState, prop: string, value: unknown) => applyOperations(s, [{ type: 'instance.setProp', owner, nodeId: node.id, prop, value }]).state;
    let s = set(start, 'endpoint', 'https://formspree.io/f/abc123');
    s = set(s, 'provider', 'web3forms');
    s = set(s, 'accessKey', 'abc-123');
    s = set(s, 'provider', 'netlify');
    s = set(s, 'provider', 'endpoint');
    expect(home(s).nodes[node.id]).toMatchObject({ props: { provider: 'endpoint', endpoint: 'https://formspree.io/f/abc123', accessKey: 'abc-123' } });
    expect(unconnected(s)).toEqual([]);
    s = set(s, 'provider', 'web3forms');
    expect(formServiceSetup(s.components[node.definitionId], (home(s).nodes[node.id] as InstanceNode).props)).toMatchObject({ prop: 'accessKey', problem: undefined });
  });

  it('names the selected service’s missing setting in the project check', () => {
    const { s, node } = withForm();
    expect(unconnected(s)).toEqual([expect.stringContaining(FORM_SERVICES.endpoint.missing)]);
    node.props.endpoint = 'http://insecure.example/f';
    expect(unconnected(s)).toEqual([expect.stringContaining(FORM_SERVICES.endpoint.invalid!)]);
    node.props.provider = 'web3forms';
    expect(unconnected(s)).toEqual([expect.stringContaining(FORM_SERVICES.web3forms.missing)]);
    node.props.provider = 'netlify';
    node.props.formName = '';
    expect(unconnected(s)).toEqual([expect.stringContaining(FORM_SERVICES.netlify.missing)]);
    node.props.formName = null;
    expect(unconnected(s)).toEqual([]);
    node.props.provider = 'mailchimp';
    expect(unconnected(s)).toEqual([expect.stringContaining('Choose a form service')]);
    expect(formConnectionProblem(contactForm, { provider: 'mailchimp' })).toMatch(/Choose a form service/);
  });
});
