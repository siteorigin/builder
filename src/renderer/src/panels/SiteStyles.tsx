import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Globe, Palette, RotateCcw } from 'lucide-react';
import type { TextStyleValue, TokenDef } from '@shared/types';
import { effectiveTokens } from '@generator/index';
import { getTheme, listThemes } from '@catalogue/index';
import { api } from '../store';
import { applyOps, useStore } from '../store';
import { DraftInput, Field, Section } from '../components/ui';
import { allTrees, instancesOf } from '@engine/tree';
import type { ProjectState } from '@shared/types';

const FONT_CHOICES = [
  { label: 'Inter (sans-serif)', value: "'Inter Variable', 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif" },
  { label: 'Fraunces (serif)', value: "'Fraunces Variable', 'Fraunces', Georgia, 'Times New Roman', serif" },
  { label: 'System sans-serif', value: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Georgia (serif)', value: "Georgia, 'Times New Roman', serif" },
  { label: 'Helvetica / Arial', value: "'Helvetica Neue', Helvetica, Arial, sans-serif" },
  { label: 'Monospace', value: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" }
];

/**
 * Where the Foundation theme uses each colour, checked against its base CSS and component styles, so an
 * owner can predict what a change affects. Shown as examples, not a complete list.
 */
const FOUNDATION_USES: Record<string, string> = {
  'color.background': 'Page background',
  'color.surface': 'Cards, price plans and contact boxes',
  'color.surface-alt': 'Alternate sections and soft backdrops',
  'color.text': 'Headings and body text',
  'color.muted': 'Secondary text',
  'color.brand': 'Primary buttons, links and highlights',
  'color.brand-strong': 'Primary buttons on hover',
  'color.on-brand': 'Text on primary buttons',
  'color.accent': 'Decorative highlights',
  'color.inverse': 'Dark sections and dark panels',
  'color.on-inverse': 'Text in dark sections',
  'color.border': 'Dividers',
  'color.focus': 'Keyboard focus outline on your site'
};

interface TokenUse {
  pages: Map<string, string>;
  components: Map<string, string>;
  shared: Set<string>;
}

/**
 * Where this project uses each site style, keyed by stable ids: pages, components (only those placed
 * somewhere) and the shared header/footer that are set to it.
 */
function tokenUses(state: ProjectState): Map<string, TokenUse> {
  const uses = new Map<string, TokenUse>();
  const at = (id: string) => uses.get(id) ?? uses.set(id, { pages: new Map(), components: new Map(), shared: new Set() }).get(id)!;
  const scan = (styles: unknown, mark: (u: TokenUse) => void) => {
    for (const scope of Object.values((styles ?? {}) as Record<string, Record<string, unknown>>))
      for (const v of Object.values(scope ?? {})) if (v && typeof v === 'object' && 'token' in (v as object)) mark(at(String((v as { token: string }).token)));
  };
  for (const t of allTrees(state)) {
    const mark =
      t.owner.kind === 'page'
        ? (u: TokenUse) => u.pages.set(t.owner.id, t.label)
        : t.owner.kind === 'shell'
          ? (u: TokenUse) => u.shared.add(t.label)
          : (u: TokenUse) => u.components.set(t.owner.id, t.label);
    if (t.owner.kind === 'component') {
      const def = state.components[t.owner.id];
      if (!def || !instancesOf(state, def.id).length) continue;
      for (const v of Object.values(def.variants ?? {})) for (const st of Object.values(v.styles ?? {})) scan(st, mark);
    }
    for (const n of Object.values(t.tree.nodes)) {
      scan(n.styles, mark);
      if (n.kind === 'instance') for (const o of Object.values(n.overrides ?? {})) scan(o, mark);
    }
  }
  return uses;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function resolveColor(tokens: TokenDef[], v: unknown, depth = 0): string {
  if (v && typeof v === 'object' && 'token' in (v as object) && depth < 6) return resolveColor(tokens, tokens.find((t) => t.id === (v as { token: string }).token)?.value, depth + 1);
  return String(v ?? '');
}

export function SiteStyles() {
  const snap = useStore((s) => s.snapshot);
  const [dev, setDev] = useState(false);
  useEffect(() => void api.app.info().then((i) => setDev(i.dev)), []);
  const tokens = useMemo(() => (snap ? effectiveTokens(snap.state) : []), [snap?.state.tokens]); // eslint-disable-line react-hooks/exhaustive-deps
  const uses = useMemo(() => (snap ? tokenUses(snap.state) : new Map<string, TokenUse>()), [snap?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  const [openUses, setOpenUses] = useState<string | null>(null);
  if (!snap) return null;
  const st = snap.state;
  const theme = getTheme(st.site.themeId);
  const overrides = st.tokens.overrides;
  const set = (id: string, value: unknown) => void applyOps([{ type: 'token.set', tokenId: id, value }], `Change ${tokens.find((t) => t.id === id)?.label ?? id}`, `token:${id}`);
  const group = (g: TokenDef['group']) => tokens.filter((t) => t.group === g);
  const Reset = ({ id }: { id: string }) =>
    id in overrides ? (
      <button className="icon-btn sm" title="Back to the theme's value" aria-label="Back to the theme's value" onClick={() => set(id, null)}>
        <RotateCcw />
      </button>
    ) : null;
  const site = st.site;
  const updSite = (patch: Record<string, unknown>) => void applyOps([{ type: 'site.update', ...patch }], 'Update site settings');

  return (
    <div className="panel-body">
      <div className="insp-head">
        <div className="insp-title">
          <span className="layer-kind">
            <Palette />
          </span>
          <h3>Site styles</h3>
        </div>
        <div className="scope-note site">
          <Globe />
          <span>
            <strong>Your whole site.</strong> Site styles apply everywhere they are used. Anything given its own custom colour keeps it.
          </span>
        </div>
      </div>
      <Section title="Colours" id="tok-color" scope="Every page">
        {group('color').map((t) => {
          const isRef = typeof t.value === 'object';
          const hex = resolveColor(tokens, t.value);
          return (
            <div className={`token-row${t.id in overrides ? ' set' : ''}`} key={t.id}>
              <div className="name">
                <label className="color-input" style={{ flex: 'none' }}>
                  <input type="color" value={/^#[0-9a-f]{6}$/i.test(hex) ? hex : '#000000'} onChange={(e) => set(t.id, e.target.value)} aria-label={`${t.label} color`} />
                </label>
                <span title={t.label} className="token-name">
                  {/* Changed colours: the name turns strong and carries its reset, as style rows do. */}
                  <span className="token-title">
                    {t.label}
                    {t.id in overrides && (
                      <button className="reset-dot" title="Changed from the theme. Click to go back to the theme's value." aria-label={`Set ${t.label} back to the theme's value`} onClick={() => set(t.id, null)}>
                        <RotateCcw />
                      </button>
                    )}
                  </span>
                  {st.site.themeId === 'foundation' && FOUNDATION_USES[t.id] && <small>Theme: {FOUNDATION_USES[t.id]}</small>}
                  {(() => {
                    const u = uses.get(t.id);
                    const linked = tokens.filter((x) => typeof x.value === 'object' && (x.value as { token?: string })?.token === t.id).map((x) => x.label);
                    const parts = [
                      u?.pages.size ? plural(u.pages.size, 'page', 'pages') : '',
                      u?.shared.size ? `the shared ${[...u.shared].join(' and ').toLowerCase()}` : '',
                      u?.components.size ? plural(u.components.size, 'component design', 'component designs') : '',
                      linked.length ? plural(linked.length, 'linked style', 'linked styles') : ''
                    ].filter(Boolean);
                    if (!parts.length) return null;
                    const names = [...(u?.pages.values() ?? []), ...(u?.shared ?? []), ...(u?.components.values() ?? []), ...linked];
                    return (
                      <>
                        <button className="uses-toggle" aria-expanded={openUses === t.id} onClick={() => setOpenUses(openUses === t.id ? null : t.id)}>
                          Set on {parts.join(' · ')}
                          <ChevronDown size={11} />
                        </button>
                        {openUses === t.id && <small className="uses-list">{names.join(', ')}</small>}
                      </>
                    );
                  })()}
                </span>
              </div>
              <div className="row">
                <DraftInput className="input sm mono hex" value={isRef ? `= ${tokens.find((x) => x.id === (t.value as { token: string }).token)?.label ?? (t.value as { token: string }).token}` : String(t.value)} onCommit={(v) => set(t.id, v.trim())} ariaLabel={`${t.label} value`} />
              </div>
            </div>
          );
        })}
      </Section>
      <Section title="Fonts" id="tok-font">
        {group('font').map((t) => (
          <Field key={t.id} label={t.label} extra={<Reset id={t.id} />}>
            <select className="select" value={FONT_CHOICES.find((f) => f.value === t.value)?.value ?? ''} onChange={(e) => set(t.id, e.target.value)} aria-label={t.label}>
              {!FONT_CHOICES.some((f) => f.value === t.value) && <option value="">Custom: {String(t.value).slice(0, 40)}</option>}
              {FONT_CHOICES.map((f) => (
                <option key={f.label} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <div className="type-sample" style={{ fontFamily: String(t.value) }}>
              Aa — The quick brown fox
            </div>
          </Field>
        ))}
      </Section>
      <Section title="Text styles" id="tok-text" defaultOpen={false}>
        {group('text').map((t) => {
          const v = t.value as TextStyleValue;
          return (
            <div key={t.id} className="col" style={{ gap: 6, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
              <div className="row">
                <strong className="grow" style={{ fontSize: 12 }}>
                  {t.label}
                </strong>
                <Reset id={t.id} />
              </div>
              <div className="grid-2">
                <Field label="Size">
                  <DraftInput className="input sm mono" value={v.size} onCommit={(size) => set(t.id, { size })} />
                </Field>
                <Field label="Weight">
                  <DraftInput className="input sm" value={String(v.weight)} onCommit={(w) => set(t.id, { weight: Number(w) })} />
                </Field>
                <Field label="Line height">
                  <DraftInput className="input sm" value={v.lineHeight} onCommit={(lineHeight) => set(t.id, { lineHeight })} />
                </Field>
                <Field label="Letter spacing">
                  <DraftInput className="input sm" value={v.tracking} onCommit={(tracking) => set(t.id, { tracking })} />
                </Field>
              </div>
              <select className="select sm" value={typeof v.family === 'object' ? (v.family as { token: string }).token : ''} onChange={(e) => set(t.id, { family: { token: e.target.value } })} aria-label={`${t.label} font`}>
                {group('font').map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </Section>
      {(['space', 'container', 'radius', 'shadow', 'border'] as const).map((g) => (
        <Section key={g} title={{ space: 'Spacing', container: 'Containers', radius: 'Corner radius', shadow: 'Shadows', border: 'Borders' }[g]} id={`tok-${g}`} defaultOpen={false}>
          {group(g).map((t) => (
            <div className="token-row" key={t.id}>
              <div className="name">
                {g === 'radius' && <span className="swatch-lg" style={{ borderRadius: String(t.value), background: 'var(--accent-soft)' }} />}
                {g === 'shadow' && <span className="swatch-lg" style={{ boxShadow: String(t.value), background: 'var(--raised)' }} />}
                <span>{t.label}</span>
              </div>
              <div className="row" style={{ gap: 4 }}>
                <DraftInput className="input sm mono" value={String(t.value)} onCommit={(v) => set(t.id, v.trim())} ariaLabel={t.label} />
                <Reset id={t.id} />
              </div>
            </div>
          ))}
        </Section>
      ))}
      <Section title="Site settings" id="site-settings">
        <Field label="Site name">
          <DraftInput value={site.name} onCommit={(v) => v.trim() && updSite({ name: v.trim() })} />
        </Field>
        <Field label="Default description" hint="Used by pages without their own description.">
          <DraftInput multiline value={site.description} onCommit={(v) => updSite({ description: v })} />
        </Field>
        <div className="grid-2">
          <Field label="Language">
            <DraftInput value={site.language} onCommit={(v) => updSite({ language: v.trim() })} />
          </Field>
          <Field label="Public URL" hint="For canonical links and the sitemap.">
            <DraftInput value={site.baseUrl ?? ''} placeholder="https://example.com" onCommit={(v) => updSite({ baseUrl: v.trim() })} />
          </Field>
        </div>
        <Field label="Favicon">
          <select className="select" value={site.favicon ?? ''} onChange={(e) => updSite({ favicon: e.target.value || null })} aria-label="Favicon">
            <option value="">None</option>
            {Object.values(st.assets.assets).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Social sharing image">
          <select className="select" value={site.socialImage ?? ''} onChange={(e) => updSite({ socialImage: e.target.value || null })} aria-label="Social image">
            <option value="">None</option>
            {Object.values(st.assets.assets).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Theme" hint="Switching keeps your content, images, project components and style overrides. You can undo it.">
          <select className="select" value={theme.id} onChange={(e) => void applyOps([{ type: 'theme.apply', themeId: e.target.value }], 'Switch theme')} aria-label="Theme">
            {listThemes()
              .filter((t) => !t.devOnly || dev || t.id === theme.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} {t.version}
                </option>
              ))}
          </select>
        </Field>
        {Object.keys(overrides).length > 0 && (
          <button className="btn btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => void applyOps(Object.keys(overrides).map((id) => ({ type: 'token.set' as const, tokenId: id, value: null })), 'Use theme defaults')}>
            <RotateCcw /> Use theme defaults
          </button>
        )}
      </Section>
    </div>
  );
}
