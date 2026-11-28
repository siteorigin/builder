/**
 * Site settings' Integrations and Custom code sections (#1485): what their closed headings say, and what each shows
 * with and without Developer mode, before and after an integration is added.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createElement, type FunctionComponent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SiteDoc } from '@shared/types';

/** Renderer code, outside the Node type-check project: loaded by path at run time. */
const PATH = '../../src/renderer/src/panels/SiteCode';
type Fields = FunctionComponent<{ site: SiteDoc; developer?: boolean; onChange: () => unknown }>;
let integrationsScope: (site: SiteDoc) => string | undefined;
let siteCodeScope: (site: SiteDoc) => string | undefined;
let SiteCodeFields: Fields;
let IntegrationFields: Fields;

beforeAll(async () => {
  ({ integrationsScope, siteCodeScope, SiteCodeFields, IntegrationFields } = (await import(/* @vite-ignore */ PATH)) as {
    integrationsScope: typeof integrationsScope;
    siteCodeScope: typeof siteCodeScope;
    SiteCodeFields: Fields;
    IntegrationFields: Fields;
  });
});

const site = (extra: Partial<SiteDoc>) => ({ name: 'Riverside', language: 'en', pageOrder: [], ...extra }) as unknown as SiteDoc;
const render = (C: Fields, props: { site: SiteDoc; developer?: boolean }) => renderToStaticMarkup(createElement(C, { ...props, onChange: () => undefined }));

describe('closed headings', () => {
  it('say which code the site has, and how many integrations are added', () => {
    expect(siteCodeScope(site({}))).toBeUndefined();
    expect(siteCodeScope(site({ headCode: '  ' }))).toBeUndefined();
    expect(siteCodeScope(site({ headCode: '<meta name="a" content="b">' }))).toBe('Head code');
    expect(siteCodeScope(site({ globalCss: 'a { color: red }' }))).toBe('CSS');
    expect(siteCodeScope(site({ headCode: '<meta name="a" content="b">', globalCss: 'a { color: red }' }))).toBe('Head code and CSS');
    expect(integrationsScope(site({}))).toBeUndefined();
    expect(integrationsScope(site({ integrations: { fathom: { siteId: 'ABCDEFGH' } } }))).toBe('1 added');
  });
});

describe('Custom code', () => {
  it('asks for Developer mode before any code can be added', () => {
    const html = render(SiteCodeFields, { site: site({}), developer: false });
    expect(html).toContain('Turn on Developer mode in Settings to add your own head code and CSS');
    expect(html).not.toContain('<textarea');
  });

  it('shows the code a site has to read without Developer mode, and to edit with it', () => {
    const coded = site({ headCode: '<meta name="a" content="b">', globalCss: 'a { color: red }' });
    const locked = render(SiteCodeFields, { site: coded, developer: false });
    expect(locked).toContain('Turn on Developer mode in Settings to change this code.');
    expect(locked.match(/<textarea[^>]*readOnly=""/gi)).toHaveLength(2);
    const open = render(SiteCodeFields, { site: coded, developer: true });
    expect(open).not.toMatch(/readonly/i);
    expect(open.match(/<textarea[^>]*spellCheck="false"/gi)).toHaveLength(2);
    expect(open).toContain('&lt;meta name=&quot;a&quot; content=&quot;b&quot;&gt;');
  });

  it('points out saved code a hand edit left unusable, as what the website is built without', () => {
    const html = render(SiteCodeFields, { site: site({ headCode: '<div>', globalCss: 42 as unknown as string }), developer: true });
    expect(html).toContain('Line 1, column 1: &lt;div&gt; cannot go in the head.');
    expect(html).toContain('What is saved here is not text.');
    expect(html.match(/The website is built without it until it is corrected\./g)).toHaveLength(2);
  });
});

describe('Integrations', () => {
  it('offers to add Fathom Analytics, and once added shows its site ID and a way to remove it', () => {
    const before = render(IntegrationFields, { site: site({}) });
    expect(before).toContain('Fathom Analytics');
    expect(before).toMatch(/>Add<span class="sr-only"> Fathom Analytics<\/span>/);
    expect(before).not.toContain('Site ID');
    const after = render(IntegrationFields, { site: site({ integrations: { fathom: { siteId: 'ABCDEFGH' } } }) });
    expect(after).toMatch(/>Remove<span class="sr-only"> Fathom Analytics<\/span>/);
    expect(after).toContain('value="ABCDEFGH"');
    expect(after).toContain('never the editor’s preview');
  });
});
