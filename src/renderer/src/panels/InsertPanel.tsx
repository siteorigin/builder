import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { icons, Search, Code, CornerDownRight, Check, Plus, SearchX, X, ArrowDown, Ellipsis, Pencil, Trash2, FileText, PanelTop, PanelBottom, Component, SwatchBook, Undo2, ChevronDown, FileCode2, Download, Upload, LayoutTemplate, SquareDashed } from 'lucide-react';
import type { ComponentDefinition, GraphNode, NodeTree, OwnerRef, ProjectState } from '@shared/types';
import type { ComponentPreviewSpec } from '@shared/component-preview';
import type { ComponentExportResult, ComponentImportResult } from '@shared/api';
import { childLists, findParent, placesOf } from '@engine/tree';
import { dependentsOf } from '@engine/definitions';
import { catalogueComponent, catalogueEntries, CATEGORY_LABELS, getTheme } from '@catalogue/index';
import { api, commitOps, getState, setState, toast, undoAction, useStore } from '../store';
import { acceptMessage, newSessionId, postToFrame } from '../lib/bridge';
import { insert, insertionPoint, insertPlan, openComponentStudio, openLayout, selectPage, type InsertSpec, type Where } from '../lib/actions';
import { elementWhere, nodeLabel, sectionWhere, whereFor, type InsertAt, type InsertRole } from '../lib/insert-at';
import { BASICS, basicHay, basicSpec, searchItems } from '../lib/insert-search';
import { beginInsertDrag } from '../lib/insert-drag';
import { ownerLabel, treeFor } from '../lib/model';
import { gridKeys, openMenus, useGridTabStops, useMenu, type MenuItem } from '../components/ui';
import { pageShowing, partName } from '@shared/page-shell';
import { usePackPreview, usePreviewExtent } from '../components/PackPreview';
import { ComponentThumb } from '../components/ComponentThumb';
import { axesOf } from '@shared/variants';

export function LucideIcon({ name, size = 15 }: { name?: string; size?: number }) {
  const key = (name ?? 'box')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join('') as keyof typeof icons;
  const I = icons[key] ?? icons.Box;
  return <I size={size} />;
}


/**
 * A small wireframe of a section's layout, drawn with the same bars as the New project starters, so a
 * section can be recognised before it is inserted. Unknown sections get a generic heading-and-text sketch.
 */
export function SectionSketch({ id }: { id: string }) {
  const bar = (w: string, h = 4, cls = '') => <i className={cls} style={{ width: w, height: h }} />;
  const key = id.split('.')[0];
  const lines = (n: number, widths = ['90%', '75%', '60%']) => [...Array(n)].map((_, i) => <i key={i} style={{ width: widths[i % widths.length], height: 3 }} />);
  switch (id) {
    case 'hero.centered':
      return (
        <span className="sketch center">
          {bar('30%', 3)}
          {bar('70%', 6, 'hi')}
          {bar('50%', 3)}
          {bar('22%', 6, 'cta')}
        </span>
      );
    case 'hero.split':
      return (
        <span className="sketch split">
          <span className="col-s">
            {bar('80%', 6, 'hi')}
            {lines(2)}
            {bar('35%', 5, 'cta')}
          </span>
          <i className="img" />
        </span>
      );
    case 'content.media':
      return (
        <span className="sketch split">
          <i className="img" />
          <span className="col-s">
            {bar('75%', 5, 'hi')}
            {lines(3)}
          </span>
        </span>
      );
    case 'intro.page':
      return (
        <span className="sketch">
          {bar('25%', 3)}
          {bar('60%', 7, 'hi')}
          {bar('80%', 3)}
        </span>
      );
    case 'content.text':
      return (
        <span className="sketch">
          {bar('50%', 5, 'hi')}
          {lines(4, ['95%', '90%', '92%', '60%'])}
        </span>
      );
    case 'cta.banner':
      return (
        <span className="sketch band center">
          {bar('55%', 5, 'hi')}
          {bar('24%', 6, 'cta')}
        </span>
      );
    case 'media.video':
      return (
        <span className="sketch">
          {bar('45%', 5, 'hi')}
          <i className="img play" />
        </span>
      );
    case 'faq.list':
      return <span className="sketch">{[...Array(4)].map((_, i) => <i key={i} className="row-line" />)}</span>;
    case 'data.table':
      return (
        <span className="sketch">
          {bar('45%', 5, 'hi')}
          {[...Array(4)].map((_, r) => (
            <span key={r} className="sketch-table-row">
              {[...Array(3)].map((_, c) => (
                <i key={c} className={r === 0 ? 'hi' : ''} style={{ width: '28%', height: r === 0 ? 4 : 3 }} />
              ))}
            </span>
          ))}
        </span>
      );
    case 'stats.row':
      return (
        <span className="sketch cols">
          {[...Array(4)].map((_, i) => (
            <span key={i} className="col-s center">
              {bar('70%', 7, 'hi')}
              {bar('60%', 3)}
            </span>
          ))}
        </span>
      );
    case 'logos.strip':
      return <span className="sketch cols mid">{[...Array(5)].map((_, i) => <i key={i} className="hi" style={{ height: 5 }} />)}</span>;
    case 'media.gallery':
      return <span className="sketch grid3">{[...Array(6)].map((_, i) => <i key={i} className="img" />)}</span>;
    case 'media.carousel':
      return <span className="sketch carousel">{[...Array(3)].map((_, i) => <i key={i} className="img" />)}</span>;
    case 'layout.section':
      return (
        <span className="sketch open">
          <i className="slot" />
        </span>
      );
    case 'team.grid':
      return (
        <span className="sketch cols">
          {[...Array(3)].map((_, i) => (
            <span key={i} className="col-s center">
              <i className="dot" />
              {bar('70%', 3)}
            </span>
          ))}
        </span>
      );
    default:
      break;
  }
  if (key === 'features' || key === 'testimonials' || key === 'pricing')
    return (
      <span className="sketch cols">
        {[...Array(3)].map((_, i) => (
          <span key={i} className="col-s card">
            {key === 'pricing' ? bar('50%', 6, 'hi') : key === 'testimonials' ? <i className="quote" /> : <i className="dot sm" />}
            {key === 'testimonials' && lines(2)}
            {key === 'testimonials' ? bar('40%', 3, 'hi') : lines(2)}
          </span>
        ))}
      </span>
    );
  if (key === 'contact')
    return (
      <span className="sketch split">
        <span className="col-s">
          {bar('60%', 5, 'hi')}
          {lines(3)}
        </span>
        <span className="col-s">
          <i className="field" />
          <i className="field" />
          {bar('40%', 6, 'cta')}
        </span>
      </span>
    );
  return (
    <span className="sketch">
      {bar('55%', 5, 'hi')}
      {lines(3)}
    </span>
  );
}



type Kind = 'section' | 'element' | 'component';
interface Item {
  key: string;
  kind: Kind;
  name: string;
  description: string;
  hay: string;
  group: string;
  spec: InsertSpec;
  /** A section's thumbnail, drawn when its theme pack was built. */
  preview?: { pack: string; file: string };
  /** A section shown in one of its variants: the option's name ("Dark"), and its axis ("Tone"). */
  variant?: { option: string; axis: string };
  /** A section as the theme ships it, in Variants: the default options that have names of their own ("Soft background"). */
  defaults?: string;
  icon?: string;
  code?: boolean;
  /** Project components: how many times it is placed. */
  uses?: number;
  /** Project components: where it is used, in a few words, and whether it is unused (or needed only by code). */
  usage?: Usage;
  /** Project components: listed under the component it was copied from (Make unique), one step in. */
  depth?: 0 | 1;
  /** Project components: the component this one is a separate copy of, by name. */
  copyOf?: string;
  /** Project components: the theme section this one is the project's copy of, by name. */
  themeCopy?: string;
}

/** Where a saved component is used: the row's one line, the menu's heading, and the preview's list. */
interface Usage {
  count: number;
  /** "Used 2 times", "Not used", "Needed by code". */
  short: string;
  /** Where, compactly: "Home, About", "Shared footer", "4 places". */
  where: string;
  status: 'used' | 'needed' | 'unused';
  /** Each place, in site order, for the preview: "Home", "About (2)", "Shared footer". */
  places: string[];
}
function usageOf(st: ProjectState, definitionId: string): Usage {
  const places = placesOf(st, definitionId);
  const count = places.reduce((n, p) => n + p.nodeIds.length, 0);
  const named = places.map((p) => (p.owner.kind === 'shell' ? `Shared ${p.label.toLowerCase()}` : p.owner.kind === 'component' ? `In ${p.label}` : p.label));
  // The row's version is short and never cut mid-list: "Footer", "Home +1".
  const brief = places.map((p, i) => (p.owner.kind === 'shell' ? p.label : named[i]));
  const where = brief.length > 1 ? `${brief[0]} +${brief.length - 1}` : (brief[0] ?? '');
  const listed = named.map((n, i) => (places[i].nodeIds.length > 1 ? `${n} (${places[i].nodeIds.length})` : n));
  if (count) return { count, short: `Used ${usedTimes(count)}`, where, status: 'used', places: listed };
  if (dependentsOf(st, definitionId).length) return { count, short: 'Needed by code', where: '', status: 'needed', places: [] };
  return { count, short: 'Not used', where: '', status: 'unused', places: [] };
}

/**
 * A saved component's design as a small wireframe, drawn from the design itself: its headings, text, pictures and
 * buttons, side by side where its rows and grids put them. A code component is read from its markup. Bars are those
 * of the section sketches, so a component and a section read alike.
 */
function DesignSketch({ def, st }: { def: ComponentDefinition; st: ProjectState }) {
  const marks = def.tree ? treeMarks(def.tree.rootIds, def.tree.nodes, st) : codeMarks(def.source ?? '');
  // A copy of a theme section whose design says too little to draw keeps that section's shape.
  const from = def.provenance?.componentId;
  if (marks.length < 2 && from && catalogueComponent(st.site.themeId, from)) return <SectionSketch id={from} />;
  return <span className="sketch design">{marks.length ? marks : [<i key="a" className="hi" style={{ width: '55%', height: 5 }} />, <i key="b" style={{ width: '85%', height: 3 }} />, <i key="c" style={{ width: '65%', height: 3 }} />]}</span>;
}
function treeMarks(rootIds: string[], nodes: Record<string, GraphNode>, st: ProjectState): ReactNode[] {
  let budget = 9;
  const style = (n: GraphNode, key: string) => ((n.styles?.desktop as Record<string, unknown> | undefined)?.[key] ?? (n.styles?.base as Record<string, unknown> | undefined)?.[key]) as unknown;
  const walk = (id: string, depth: number): ReactNode[] => {
    const n = nodes[id];
    if (!n || budget <= 0 || depth > 5) return [];
    switch (n.kind) {
      case 'text': {
        budget--;
        const tag = typeof n.tag === 'string' ? n.tag : 'h2';
        if (/^h[1-3]$/.test(tag)) return [<i key={id} className="hi" style={{ width: '68%', height: 5 }} />];
        if (/^h[4-6]$/.test(tag)) return [<i key={id} className="hi" style={{ width: '48%', height: 4 }} />];
        return [<i key={id} style={{ width: '88%', height: 3 }} />, <i key={`${id}:2`} className="l2" style={{ width: '62%', height: 3 }} />];
      }
      case 'image':
        budget--;
        return [<i key={id} className="img" />];
      case 'link':
        budget--;
        return [<i key={id} className="cta" style={{ width: '34%', height: 5 }} />];
      case 'icon':
        budget--;
        return [<i key={id} className="dot sm" />];
      case 'divider':
        return [<i key={id} className="row-line" style={{ height: 1 }} />];
      case 'slot':
        return [<i key={id} className="slot" />];
      case 'instance':
        budget--;
        return [<i key={id} className="nest" title={st.components[n.definitionId]?.name} />];
      case 'repeat': {
        const kids = n.children.flatMap((c) => walk(c, depth + 1));
        return [
          <span key={id} className="sk-row">
            {[0, 1, 2].map((k) => (
              <span key={k} className="col-s card">
                {kids}
              </span>
            ))}
          </span>
        ];
      }
      case 'element': {
        const kids = n.children.slice(0, 6).map((c) => walk(c, depth + 1));
        const layout = style(n, 'layout');
        const across = layout === 'row' || (layout === 'grid' && Number(style(n, 'columns')) > 1);
        if (across && kids.filter((k) => k.length).length > 1)
          return [
            <span key={id} className="sk-row">
              {kids.map((k, i) => (
                <span key={i} className="col-s">
                  {k}
                </span>
              ))}
            </span>
          ];
        return kids.flat();
      }
      default:
        return [];
    }
  };
  return rootIds.flatMap((r) => walk(r, 0));
}
function codeMarks(source: string): ReactNode[] {
  // Read as markup (Svelte's own blocks are left as text). Side by side only where the component's own styles (or
  // utility classes) put things in a row or a grid of columns; anything else stacks, as the markup alone reads.
  const markup = source.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '');
  const across = new Set<string>();
  for (const css of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi))
    for (const rule of css[1].matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decl = rule[2].replace(/\s+/g, '');
      const row = (/display:(inline-)?flex/.test(decl) && !/flex-direction:column/.test(decl)) || (/display:(inline-)?grid/.test(decl) && /grid-template-columns:(?!1fr;|1fr$|none)/.test(decl));
      if (row) for (const sel of rule[1].split(',')) across.add(sel.trim().split(/[\s>+~:]/).pop() ?? '');
    }
  const sideBySide = (el: Element) =>
    across.has(el.tagName.toLowerCase()) ||
    [...el.classList].some((c) => across.has(`.${c}`) || c === 'flex' || /^(?:[a-z]+:)?grid-cols-([2-9]|1\d)$/.test(c)) ||
    /display:\s*(inline-)?flex|grid-template-columns/.test(el.getAttribute('style') ?? '');
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(`<body>${markup}</body>`, 'text/html');
  } catch {
    return [];
  }
  let budget = 9;
  let n = 0;
  const walk = (el: Element, depth: number): ReactNode[] => {
    if (budget <= 0 || depth > 6) return [];
    const tag = el.tagName.toLowerCase();
    const k = `${n++}`;
    if (/^h[1-6]$/.test(tag)) return budget--, [<i key={k} className="hi" style={{ width: tag < 'h4' ? '64%' : '46%', height: tag < 'h4' ? 5 : 4 }} />];
    if (tag === 'p' || tag === 'li' || tag === 'blockquote') return budget--, [<i key={k} style={{ width: '86%', height: 3 }} />, <i key={`${k}b`} className="l2" style={{ width: '60%', height: 3 }} />];
    if (tag === 'img' || tag === 'picture' || tag === 'video' || tag === 'iframe') return budget--, [<i key={k} className="img" />];
    if (tag === 'button' || (tag === 'a' && !el.children.length)) return budget--, [<i key={k} className="cta" style={{ width: '32%', height: 5 }} />];
    if (tag === 'svg') return budget--, [<i key={k} className="dot sm" />];
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return budget--, [<i key={k} className="field" />];
    const kids = [...el.children].map((c) => walk(c, depth + 1)).filter((m) => m.length);
    // Controls laid out in a line sit in a line; blocks laid out side by side are columns.
    const inRow = sideBySide(el);
    if (inRow && kids.length > 1 && kids.every((m) => m.length === 1))
      return [
        <span key={k} className="sk-row inline">
          {kids.map((m, i) => (
            <span key={i} className="col-s">
              {m}
            </span>
          ))}
        </span>
      ];
    if (inRow && kids.length > 1 && kids.length <= 4)
      return [
        <span key={k} className="sk-row">
          {kids.map((m, i) => (
            <span key={i} className="col-s card">
              {m}
            </span>
          ))}
        </span>
      ];
    return kids.flat();
  };
  return [...doc.body.children].flatMap((c) => walk(c, 0));
}

/**
 * A saved component rendered on its own, as visitors see it, by the editor's isolated preview (never part of the
 * site): prepared for this component and its options, shown in a frame at the canvas width and scaled down to fit,
 * cropped to the component. Its sketch stands in while it loads, or when the preview cannot show it.
 */
const LIVE_W = 320;
const LIVE_MAX_H = 232;
const LIVE_MIN_SCALE = 0.16;
export function LivePreview({ spec, fallback, label, maxH = LIVE_MAX_H }: { spec: ComponentPreviewSpec; fallback: ReactNode; label?: string; maxH?: number }) {
  const runtime = useStore((s) => s.runtime);
  const revision = useStore((s) => s.snapshot?.revision);
  const width = useStore((s) => s.viewport) || 1280;
  const url = runtime.state === 'ready' ? runtime.url : null;
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useMemo(newSessionId, []);
  const [live, setLive] = useState<{ phase: 'loading' | 'ready' | 'failed'; src?: string; top?: number; height?: number }>({ phase: 'loading' });
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    if (!url) {
      setLive({ phase: 'failed' });
      return;
    }
    let gone = false;
    let key: string | null = null;
    let measure = '';
    const origin = new URL(url).origin;
    let path = '';
    const remeasure: Array<ReturnType<typeof setTimeout>> = [];
    let poll: ReturnType<typeof setInterval> | undefined;
    let sized = false;
    let over = false;
    const onMsg = (e: MessageEvent) => {
      const m = acceptMessage(e, frame.current, origin, session);
      if (!m || gone || over || m.navigationId !== path) return;
      if (m.type === 'ready') {
        if (!(m.payload as { preview?: { mounted?: boolean } }).preview?.mounted) return setLive({ phase: 'failed' });
        postToFrame(frame.current, origin, session, 'mode', { mode: 'preview' });
        // Measured at once, and again as late images and fonts settle its height.
        const ask = () => {
          if (gone) return;
          measure = newSessionId();
          postToFrame(frame.current, origin, session, 'inspect', { requestId: measure });
        };
        ask();
        remeasure.push(setTimeout(ask, 700), setTimeout(ask, 1800));
        // Nothing to show yet: keep asking until it has a size, or the deadline passes.
        poll = setInterval(() => !sized && ask(), 600);
      } else if (m.type === 'inspectResult' && (m.payload as { requestId?: unknown }).requestId === measure) {
        const b = (m.payload as { report?: { preview?: { bounds?: { y: number; height: number } | null } } }).report?.preview?.bounds;
        // A measurement with nothing to show yet keeps the frame (and any earlier size) for the next one; only the
        // deadline gives up.
        if (b && b.height > 0) {
          sized = true;
          clearInterval(poll);
          setLive((l) => ({ phase: 'ready', src: l.src, top: Math.max(0, b.y), height: b.height }));
        }
      }
    };
    window.addEventListener('message', onMsg);
    setLive({ phase: 'loading' });
    const late = setTimeout(() => {
      over = true;
      clearInterval(poll);
      if (!gone) setLive((l) => (l.phase === 'loading' ? { phase: 'failed' } : l));
    }, 20000);
    api.project.prepareComponentPreview(spec).then(
      (p) => {
        if (!p.ok) return !gone && !over && setLive({ phase: 'failed' });
        if (gone || over) return void api.project.releaseComponentPreview(p.key).catch(() => undefined);
        key = p.key;
        path = p.path;
        setLive({ phase: 'loading', src: url + p.path });
      },
      () => !gone && !over && setLive({ phase: 'failed' })
    );
    return () => {
      gone = true;
      clearTimeout(late);
      remeasure.forEach(clearTimeout);
      clearInterval(poll);
      window.removeEventListener('message', onMsg);
      if (key) void api.project.releaseComponentPreview(key).catch(() => undefined);
    };
  }, [specKey, url, revision, session]);
  // Scaled to fit the whole component in the frame, down to a floor below which it is cropped to its top instead, and
  // centred when it ends up narrower than the frame.
  const h = live.height ?? 0;
  const scale = Math.min(LIVE_W / width, Math.max(LIVE_MIN_SCALE, h ? (maxH - 4) / h : 1));
  const shown = live.phase === 'ready' ? Math.min(maxH, Math.max(56, Math.ceil(h * scale) + 4)) : 0;
  const cropped = live.phase === 'ready' && h * scale > maxH;
  const inset = Math.max(0, Math.round((LIVE_W - width * scale) / 2));
  return (
    <span className={`insert-live${cropped ? ' cropped' : ''}`} data-preview-state={live.phase} style={live.phase === 'ready' ? { height: shown } : undefined}>
      {live.src && (
        <iframe
          ref={frame}
          name={session}
          src={live.src}
          title=""
          aria-hidden="true"
          tabIndex={-1}
          sandbox="allow-scripts allow-same-origin"
          style={{ width, height: Math.max(900, Math.ceil((live.top ?? 0) + (live.height ?? 0)) + 4), left: inset, transform: `scale(${scale}) translateY(${-(live.top ?? 0)}px)`, visibility: live.phase === 'ready' ? undefined : 'hidden' }}
        />
      )}
      {cropped && <span className="insert-peek-note">Top of the design</span>}
      {live.phase !== 'ready' && (
        <span className="insert-live-wait">
          {fallback}
          <span className="insert-peek-note">{live.phase === 'loading' ? 'Loading preview' : `Layout sketch · ${label ? `${label} preview` : 'preview'} unavailable`}</span>
        </span>
      )}
    </span>
  );
}

/** Level with the top of its tile and kept inside the window, as its size changes (a live preview arriving). */
function usePeekTop(ref: React.RefObject<HTMLDivElement | null>, anchor: DOMRect, panel: DOMRect) {
  const [top, setTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () => setTop(Math.round(Math.max(panel.top + 8, Math.min(anchor.top - 8, window.innerHeight - el.offsetHeight - 12))));
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [anchor.top, panel.top]);
  return top;
}

/**
 * A larger look at a saved component beside the panel: the component itself, rendered live; what it is (a design,
 * code, a copy of another); where it is used; and where it lands among the sections around it. Like the section
 * preview it is never a target and is hidden from assistive technology, which hears the same from the row.
 */
function LibraryPeek({ it, def, st, anchor, panel, map, onEnter, onLeave }: { it: Item; def: ComponentDefinition; st: ProjectState; anchor: DOMRect; panel: DOMRect; map: Neighbours | null; onEnter: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const top = usePeekTop(ref, anchor, panel);
  const left = Math.round(Math.min(panel.right + 10, window.innerWidth - 346 - 8));
  const usage = it.usage;
  const what = def.kind === 'code' ? 'Code component' : 'Your design';
  const lineage = it.variant ? `${it.variant.axis.toLowerCase()} option` : it.copyOf ? `separate copy of ${it.copyOf}` : it.themeCopy ? `copy of the theme’s ${it.themeCopy} section` : null;
  return createPortal(
    <div ref={ref} className="insert-peek lib" style={{ left, top: top ?? Math.round(anchor.top), visibility: top === null ? 'hidden' : undefined }} aria-hidden="true" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <span className="insert-peek-shot">
        <LivePreview key={it.key} label={it.variant?.option} maxH={Math.max(96, Math.min(LIVE_MAX_H, window.innerHeight - 420))} spec={{ definitionId: def.id, ...(it.spec.variants ? { variants: it.spec.variants } : {}) }} fallback={<DesignSketch def={def} st={st} />} />
      </span>
      <span className="insert-peek-name">
        <strong>{it.name}</strong>
        {it.variant && <span className="insert-peek-option">{it.variant.option}</span>}
      </span>
      <span className="insert-peek-kind">
        {def.kind === 'code' ? <Code /> : <Component />}
        <span>{lineage ? `${what} · ${lineage}` : what}</span>
      </span>
      {it.description && <span className="insert-peek-desc">{it.description}</span>}
      {usage && (
        <span className={`insert-peek-usage ${usage.status}`}>
          <b>{(it.variant ? 'The component is ' : '') + (usage.status === 'used' ? `${it.variant ? usage.short.toLowerCase() : usage.short}:` : usage.status === 'needed' ? (it.variant ? 'not placed, but needed by code' : 'Not placed, but needed by code') : it.variant ? 'not used anywhere yet' : 'Not used anywhere yet')}</b>
          {usage.status === 'used' && ` ${usage.places.slice(0, 4).join(', ')}${usage.places.length > 4 ? ` and ${usage.places.length - 4} more` : ''}`}
        </span>
      )}
      {map && (
        <span className="insert-peek-map">
          <span className="ctx">{map.before ?? `Top of ${map.owner}`}</span>
          <span className="new">
            <Plus />
            <span>{fullName(it)}</span>
          </span>
          <span className="ctx">{map.after ?? `End of ${map.owner}`}</span>
        </span>
      )}
    </div>,
    document.body
  );
}
/** The places either side of where a new section or component lands, for the preview's map: the page's sections, or
 *  what is already in the container it goes into. */
type Neighbours = { owner: string; before: string | null; after: string | null };
function neighboursAt(st: ProjectState, at: InsertAt | null): Neighbours | null {
  const tree = at ? treeFor(st, at.owner) : undefined;
  if (!at || !tree) return null;
  const parent = at.parentId && Object.hasOwn(tree.nodes, at.parentId) ? tree.nodes[at.parentId] : undefined;
  if (at.parentId && !parent) return null;
  const lists = parent ? childLists(parent) : [];
  const ids = parent ? ((at.slot ? lists.find((l) => l.slot === at.slot) : lists[0])?.ids ?? []) : tree.rootIds;
  const index = at.index ?? ids.length;
  const label = (nodeId: string | undefined) => (nodeId ? nodeLabel(st, at.owner, nodeId) : null);
  return { owner: parent ? nodeLabel(st, at.owner, parent.id) : ownerLabel(st, at.owner), before: label(ids[index - 1]), after: label(ids[index]) };
}

/** A place in words, with the container it is in when that is not the page: "Exhibitor card in Exhibitors grid". */
const placeText = (w: NonNullable<Where>) => (w.within ? `${w.target} in ${w.within}` : w.target);
const sameWhere = (a: Where, b: Where) => a === b || (!!a && !!b && a.lead === b.lead && placeText(a) === placeText(b));

/** Saved components shown before "Show all", so a large library never buries the built-in catalogue. */
const MINE_SHOWN = 4;

/** The tiles and results that open a larger preview beside the panel: sections and saved components. */
const peekable = (kind?: string) => kind === 'section' || kind === 'component';

const KIND_SUBJECT: Record<Kind, string> = { section: 'Sections go', element: 'Elements go', component: 'Components go' };

/** How far, in pixels, a pressed tile moves before it is dragged rather than clicked. */
const DRAG_START = 5;

/** How the confirmation stays up after an insert, unless the selection moves on first. */
const ADDED_MS = 6000;

/** A section's choice in Variants: its option, or the section as the theme ships it. */
const optionLabel = (it: Item) => it.variant?.option ?? 'Theme default';
/** The name an inserted item is called by in history and the confirmation: "Centered hero (Dark)". */
const fullName = (it: Item) => (it.variant ? `${it.name} (${it.variant.option})` : it.name);

/** One line of the destination strip: an item in bold, what happens, and the place in bold. */
type Line = { name?: string; verb: string; target?: string; full?: string };
const lineText = (l: Line) => l.full ?? [l.name, l.verb, l.target].filter(Boolean).join(' ');
/** A placement on a row of its own, compact: "New section after", "After", "Inside", "At the end of". */
const placeLead = (lead: string) => {
  const short = lead.replace(/^in a new section /, 'new section ');
  return short[0].toUpperCase() + short.slice(1);
};
/**
 * A line with no item is a sentence over up to two rows. An item's line gives the item one row and its placement the
 * other, and a placement row keeps its relation ("new section after") whole and shortens the place's name if it must.
 */
function Placement({ verb, target }: { verb: string; target?: string }) {
  return (
    <span className="rl">
      <span className="rel">{verb}</span>
      {target && <b className="tgt">{target}</b>}
    </span>
  );
}
function LineText({ line, row }: { line: Line; row?: boolean }) {
  if (row) return <Placement verb={line.verb} target={line.target} />;
  if (line.name)
    return (
      <>
        <span className="nm">
          <b>{line.name}</b>
        </span>
        <Placement verb={line.verb} target={line.target} />
      </>
    );
  return (
    <>
      {line.verb} {line.target && <b>{line.target}</b>}
    </>
  );
}

/** Artwork that is all but blank (an empty Section) shows its layout sketch instead. */
const SPARSE = 0.05;
/**
 * Sections that are inserted without their media, so their artwork shows little more than a heading. The larger
 * preview adds their layout sketch in a corner, so both the theme's look and the section's shape are visible. A
 * measured threshold cannot pick them out: Statistics' useful artwork reaches no further down than Gallery's heading.
 */
const STARTS_EMPTY = new Set(['media.gallery', 'media.carousel', 'media.video']);

function ItemIcon({ it }: { it: Item }) {
  return (
    <span className="ico">
      <LucideIcon name={it.icon} />
    </span>
  );
}

/**
 * A section's thumbnail from its theme pack, or a sketch of its layout while that loads, when there is none, or when
 * the thumbnail is almost all empty background.
 */
function SectionThumb({ it }: { it: Item }) {
  const url = usePackPreview(it.preview?.pack, it.preview?.file);
  const [broken, setBroken] = useState<string | null>(null);
  const shot = url && url !== broken ? url : null;
  const extent = usePreviewExtent(it.preview?.pack, it.preview?.file, shot);
  if (shot && extent >= SPARSE) return <img className="insert-shot" src={shot} alt="" draggable={false} onError={() => setBroken(shot)} />;
  // Marked when the sketch is chosen over loaded artwork, rather than standing in while it loads.
  return shot ? (
    <span className="sparse">
      <SectionSketch id={it.spec.componentId!} />
    </span>
  ) : (
    <SectionSketch id={it.spec.componentId!} />
  );
}

/**
 * A larger look at the section under the pointer or keyboard, beside the panel over the canvas: the pack's thumbnail
 * at its own size, what the section is for, and a map of where it lands among the sections around it. It is never
 * a target (the tile stays the one thing to click), so it is hidden from assistive technology, which hears the same
 * description and destination from the tile itself.
 */
function InsertPeek({ it, anchor, panel, option, map, onEnter, onLeave }: { it: Item; anchor: DOMRect; panel: DOMRect; option: string | null; map: Neighbours | null; onEnter: () => void; onLeave: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState<number | null>(null);
  const url = usePackPreview(it.preview?.pack, it.preview?.file);
  const [broken, setBroken] = useState<string | null>(null);
  // A short section gets a tighter frame: its figures or logos, not the empty background below them. One that is
  // nearly all background shows its layout sketch, as its tile does.
  const extent = usePreviewExtent(it.preview?.pack, it.preview?.file, url && url !== broken ? url : null);
  const shot = url && url !== broken && extent >= SPARSE ? url : null;
  const frame = extent < 0.75 ? Math.max(100, Math.round(200 * extent) + 16) : 200;
  // Level with the top of its tile, kept inside the window.
  useLayoutEffect(() => {
    const h = ref.current?.offsetHeight ?? 0;
    setTop(Math.round(Math.max(panel.top + 8, Math.min(anchor.top - 8, window.innerHeight - h - 12))));
  }, [anchor.top, panel.top, it.key, frame, !!shot]);
  const left = Math.round(Math.min(panel.right + 10, window.innerWidth - 346 - 8));
  return createPortal(
    <div ref={ref} className="insert-peek" style={{ left, top: top ?? Math.round(anchor.top), visibility: top === null ? 'hidden' : undefined }} aria-hidden="true" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <span className="insert-peek-shot">
        {shot ? (
          <>
            <img className="insert-shot" src={shot} alt="" draggable={false} style={{ height: frame }} onError={() => setBroken(shot)} />
            {STARTS_EMPTY.has(it.spec.componentId!) && (
              <span className="insert-peek-inset">
                <SectionSketch id={it.spec.componentId!} />
                <span>Layout</span>
              </span>
            )}
          </>
        ) : (
          <>
            <SectionSketch id={it.spec.componentId!} />
            <span className="insert-peek-note">Layout sketch</span>
          </>
        )}
      </span>
      <span className="insert-peek-name">
        <strong>{it.name}</strong>
        {option && <span className="insert-peek-option">{option}</span>}
      </span>
      {it.description && <span className="insert-peek-desc">{it.description}</span>}
      {map && (
        <span className="insert-peek-map">
          <span className="ctx">{map.before ?? `Top of ${map.owner}`}</span>
          <span className="new">
            <Plus />
            <span>{it.name}</span>
          </span>
          <span className="ctx">{map.after ?? `End of ${map.owner}`}</span>
        </span>
      )}
    </div>,
    document.body
  );
}

/** Whether the Insert panel lists every variant of a section, remembered on this computer. */
const VARIANTS_KEY = 'insert.variants';
function readShowVariants(): boolean {
  try {
    return localStorage.getItem(VARIANTS_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Show a component's placement on a page or in the shared header or footer, as the project is now: a menu opened
 * earlier may name a page or placement that has gone since. The shared areas are shown on the current page, or the
 * first page that shows them.
 */
function showPlacement(definitionId: string, owner: OwnerRef, nodeId?: string): boolean {
  const s = getState();
  const st = s.snapshot?.state;
  const place = st && placesOf(st, definitionId).find((p) => p.owner.kind === owner.kind && p.owner.id === owner.id);
  if (!st || !place) return void toast('That placement has been removed since the menu opened.', 'info'), false;
  if (nodeId && !place.nodeIds.includes(nodeId)) return void toast('That placement has been removed since the menu opened.', 'info'), false;
  // A collection's layout is shown on one of its entries, as editing it shows it.
  if (owner.kind === 'template') {
    openLayout(owner.id);
    setState({ selection: { owner, instancePath: [], nodeId: nodeId ?? place.nodeIds[0] }, rightTab: 'inspect', dockOpen: true });
    return true;
  }
  const current = s.definitionMode?.returnPageId ?? s.pageId;
  const pageId = owner.kind === 'page' ? owner.id : pageShowing(st, owner.id, current);
  if (nodeId && !place.nodeIds.includes(nodeId)) return void toast('That placement has been removed since the menu opened.', 'info'), false;
  if (!pageId) return void toast(`No page shows ${partName(owner.id)}, so this placement is not visible anywhere.`, 'info'), false;
  selectPage(pageId);
  setState({ selection: { owner, instancePath: [], nodeId: nodeId ?? place.nodeIds[0] }, rightTab: 'inspect', dockOpen: true });
  return true;
}

/**
 * Edit a component's design everywhere, the way the Inspector does: at its first placement on a page or in the
 * shared header or footer, through the same dialog, which says how many placements change.
 */
function editEverywhere(definitionId: string) {
  const st = getState().snapshot?.state;
  const now = getState();
  const current = now.definitionMode?.returnPageId ?? now.pageId;
  // A page placement first, else a shared header or footer that some page shows.
  const places = st ? placesOf(st, definitionId) : [];
  const first = places.find((p) => p.owner.kind === 'page') ?? places.find((p) => p.owner.kind === 'shell' && !!st && !!pageShowing(st, p.owner.id, current));
  if (!first || !showPlacement(definitionId, first.owner)) return;
  const sel = getState().selection;
  if (sel && sel.nodeId === first.nodeIds[0]) setState({ modal: { kind: 'edit-definition', ref: sel } });
}

/** A tree's nodes in the order they appear on the page. */
function documentOrder(tree: NodeTree): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    if (out.includes(id)) return;
    out.push(id);
    const n = tree.nodes[id];
    if (n) for (const l of childLists(n)) l.ids.forEach(walk);
  };
  tree.rootIds.forEach(walk);
  return out;
}
/** Where a placement sits, for telling several on one page apart: "in Team", "after Intro", "at the top". */
function whereIn(st: ProjectState, owner: OwnerRef, tree: NodeTree, nodeId: string): string {
  const at = findParent(tree, nodeId);
  if (!at) return 'on the page';
  if (at.parentId) return `in ${nodeLabel(st, owner, at.parentId)}`;
  return at.index ? `after ${nodeLabel(st, owner, at.list[at.index - 1])}` : 'at the top';
}

/** The place part of a usage line: the place's name gives way before its "+N" does. */
function Where({ text }: { text: string }) {
  if (!text) return null;
  const more = / \+\d+$/.exec(text)?.[0];
  return (
    <span className="at">
      <span className="nm"> · {more ? text.slice(0, -more.length) : text}</span>
      {more && <span className="more">{more}</span>}
    </span>
  );
}

/** How often a component is placed, in the Inspector's words: "once", "3 times". */
const usedTimes = (n: number) => (n === 1 ? 'once' : `${n} times`);

/**
 * Tiles in a two-column APG grid: one tab stop, arrow keys between tiles, Enter or Space to add. With `aside`, each
 * tile is followed in its row by a cell of its own (the library's manage button), reached with the arrow keys. With
 * `bands`, each band starts a new row under a row header naming it (a section's variants under the section's name).
 * Each of `extra` is a full-width cell of its own after the tiles.
 */
function TileGrid({ items, bands, labelledBy, className = '', cols = 2, render, aside, extra = [] }: { items?: Item[]; bands?: Array<{ key: string; label: string; items: Item[] }>; labelledBy: string; className?: string; cols?: 1 | 2; render: (it: Item) => ReactNode; aside?: (it: Item) => ReactNode; extra?: ReactNode[] }) {
  const cell = (key: string, content: ReactNode) => (
    <div role="gridcell" className="insert-cell" key={key}>
      {content}
    </div>
  );
  const unitsOf = (list: Item[]) => list.map((it) => [cell(it.key, render(it)), ...(aside ? [cell(`${it.key}:aside`, aside(it))] : [])]);
  const rowsOf = (units: ReactNode[][], base: string) => {
    const rows: ReactNode[] = [];
    for (let i = 0; i < units.length; i += cols)
      rows.push(
        <div role="row" className="insert-row" key={`${base}:${i}`}>
          {units.slice(i, i + cols).flat()}
        </div>
      );
    return rows;
  };
  const rows = bands
    ? bands.flatMap((b) => [
        <div role="row" className="insert-row" key={`${b.key}:head`}>
          <div role="rowheader" className="insert-band">
            {b.label}
          </div>
        </div>,
        ...rowsOf(unitsOf(b.items), b.key)
      ])
    : rowsOf(unitsOf(items ?? []), 'tiles');
  extra.forEach((x, i) =>
    rows.push(
      <div role="row" className="insert-row" key={`extra:${i}`}>
        {cell(`extra:${i}`, x)}
      </div>
    )
  );
  return (
    <div role="grid" aria-labelledby={labelledBy} className={`insert-grid ${className}`}>
      {rows}
    </div>
  );
}

export function InsertPanel() {
  const snap = useStore((s) => s.snapshot);
  // Read so the destinations below follow the selection, the page and component editing.
  const selection = useStore((s) => s.selection);
  useStore((s) => s.pageId);
  useStore((s) => s.definitionMode);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const open = useStore((s) => s.leftTab === 'insert');
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  // What the destination line describes: the item under the pointer, else the one with keyboard focus (by key), else
  // the group scrolled to the top of the list. 'new' is the New code component action, which opens an editor instead
  // of inserting anywhere, and 'new-component' is Create component, which opens its dialog.
  const [pointed, setPointed] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState<Kind | null>(null);
  const [allMine, setAllMine] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [showVariants, setShowVariants] = useState(readShowVariants);
  const toggleVariants = () => {
    const next = !showVariants;
    setShowVariants(next);
    try {
      localStorage.setItem(VARIANTS_KEY, next ? '1' : '0');
    } catch {
      // Not remembered, but shown.
    }
  };
  const browseTop = useRef(0);
  // The last insert, confirmed in the strip with an Undo for it. `known`: the history entries before it, so its own
  // entry can be told from any other change with the same name.
  const [added, setAdded] = useState<{ key: string; kind: Kind; name: string; where: Where; n: number; selection: unknown; known: string[] } | null>(null);
  // The section shown larger beside the panel, and the tile or result it is for.
  const [peek, setPeek] = useState<{ key: string; rect: DOMRect } | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The item whose preview Escape put away: it stays away until the highlight, focus or pointer moves to another.
  const dismissed = useRef<string | null>(null);
  // The pointer, or focus, is on the confirmation (its Undo): it stays up until both have left.
  const [holdPointer, setHoldPointer] = useState(false);
  const [holdFocus, setHoldFocus] = useState(false);
  const hold = holdPointer || holdFocus;
  const adding = useRef(false);
  /** The press that began on a tile became a drag onto the canvas: the click it ends with adds nothing. */
  const dragged = useRef(false);
  const stripRef = useRef<HTMLDivElement>(null);
  const [typing, setTyping] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const menu = useMenu();
  useGridTabStops(bodyRef);
  const revision = snap?.revision;
  // The component whose manage menu is open. Once it has gone (the AI, an Undo) its menu closes; anything else the
  // menu offers is checked again when it is chosen.
  const menuFor = useRef<string | null>(null);
  // The component deleted from its menu, until it has gone. Its row goes with it, and focus stays in the library
  // (else search) rather than falling to the page, where the next Delete would remove the canvas selection.
  const refocus = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    if (menuFor.current && snap && !Object.hasOwn(snap.state.components, menuFor.current)) menu.close();
    if (!refocus.current || !snap || Object.hasOwn(snap.state.components, refocus.current.id)) return;
    const { index } = refocus.current;
    refocus.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    // The row that took the deleted one's place, else the one before it.
    const rows = [...(bodyRef.current?.querySelectorAll<HTMLElement>('.insert-group[data-kind="component"] .insert-tile.project') ?? [])];
    const next = rows[Math.min(index, rows.length - 1)] ?? bodyRef.current?.querySelector<HTMLElement>('.insert-group[data-kind="component"] [role="gridcell"] > *');
    if (next) {
      for (const c of next.closest('[role="grid"]')?.querySelectorAll<HTMLElement>('[role="gridcell"] > *') ?? []) c.tabIndex = c === next ? 0 : -1;
      next.focus({ preventScroll: true });
      next.scrollIntoView({ block: 'nearest' });
    } else searchRef.current?.focus({ preventScroll: true });
  }, [revision]);
  const entries = useMemo(() => (snap ? catalogueEntries(snap.state.site.themeId) : []), [snap?.state.site.themeId]);
  // Opening the panel puts the cursor in search, so typing a name finds it straight away.
  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
    else setPeek(null);
  }, [open]);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  // A preview opened by the pointer while focus is on the page is put away by Escape too, before the page's own
  // Escape (deselect) runs, and without moving focus. A menu or dialog keeps its own Escape.
  const hasPeek = !!peek;
  useEffect(() => {
    if (!hasPeek) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || openMenus.count || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      if (searchRef.current && document.activeElement === searchRef.current) return;
      if (bodyRef.current?.contains(document.activeElement)) return;
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(peekTimer.current);
      setPeek((p) => ((dismissed.current = p?.key ?? null), null));
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hasPeek]);
  // A new list (another query, or variants shown or hidden) starts at its first result, so Enter adds what is highlighted.
  useEffect(() => setActive(0), [q, showVariants]);
  useEffect(() => {
    dismissed.current = null;
  }, [active, q]);
  // Keep the highlighted result in view, so Enter never adds something off screen. `reveal` asks again on an arrow
  // press that leaves the highlight where it was (at either end of the list, after the list was scrolled).
  const [reveal, setReveal] = useState(0);
  useEffect(() => {
    if (q.trim()) document.getElementById(`${id}-r${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, q, id, reveal]);
  // While search has the cursor, the highlighted section result is shown larger beside it.
  const peekResult = () => {
    const el = q.trim() ? document.getElementById(`${id}-r${active}`) : null;
    if (peekable(el?.dataset.kind) && el && el.dataset.key !== dismissed.current && (document.activeElement === searchRef.current || el.matches(':hover'))) {
      // A close left pending by browsing (focus leaving a tile for search) must not take this preview away.
      clearTimeout(peekTimer.current);
      setPeek({ key: el.dataset.key!, rect: el.getBoundingClientRect() });
    }
    else if (q.trim()) setPeek(null);
  };
  useEffect(peekResult, [active, q, showVariants, id, reveal]);
  // Searching keeps the place in the catalogue: leaving search returns to where browsing was.
  const searching = !!q.trim();
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if (searching) body.scrollTop = 0;
    else {
      body.scrollTop = browseTop.current;
      setPeek(null);
    }
  }, [searching]);
  // A narrow sidebar gives element tiles one column (and the grid one cell per row), so names never clip, and the
  // header's actions become icons.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => setNarrow(body.clientWidth <= 232));
    ro.observe(body);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!added) {
      setHoldPointer(false);
      setHoldFocus(false);
      return;
    }
    if (hold) return;
    const t = setTimeout(() => setAdded(null), ADDED_MS);
    return () => clearTimeout(t);
  }, [added, hold]);
  // Undone some other way (the toolbar, the keyboard, History): the confirmation goes with it.
  useEffect(() => {
    const entry = added && snap?.history.entries.find((e) => e.label === `Insert ${added.name}` && !added.known.includes(e.id));
    if (entry && !entry.applied) setAdded(null);
  }, [snap?.revision, added]);
  // The confirmation gives way when the selection moves on to something else: its Undo would no longer be about
  // what is in front of the author.
  useEffect(() => {
    if (added && selection !== added.selection) setAdded(null);
  }, [selection, added]);
  if (!snap) return null;
  const st = snap.state;

  const theme = getTheme(st.site.themeId);
  // Each section, then (when asked for) each variant option on its own, pictured as it inserts.
  const sections: Item[] = entries.flatMap((e) => {
    const shots = theme.previews?.[e.componentId];
    const base: Item = {
      key: `s:${e.componentId}`,
      kind: 'section',
      name: e.name,
      description: e.description,
      hay: `${e.name} ${e.description} ${e.tags.join(' ')} ${CATEGORY_LABELS[e.category] ?? e.category} section`.toLowerCase(),
      group: CATEGORY_LABELS[e.category] ?? e.category,
      spec: { componentId: e.componentId },
      ...(shots ? { preview: { pack: theme.id, file: shots.default } } : {})
    };
    if (!showVariants) return [base];
    const def = catalogueComponent(st.site.themeId, e.componentId);
    const axes = def ? axesOf(def) : [];
    // The options the engine accepts, so every tile inserts.
    const options = axes.flatMap(([axis, a]) =>
      Object.entries(a.options)
        .filter(([option]) => option !== a.default)
        .map(([option, o]): Item => {
          const file = shots?.variants?.[axis]?.[option];
          // An option named "Default" that is not the theme's default says which default it is ("Default tone").
          const label = o.label.trim().toLowerCase() === 'default' ? `Default ${a.label.toLowerCase()}` : o.label;
          return {
            ...base,
            key: `s:${e.componentId}~${axis}=${option}`,
            hay: `${base.hay} ${a.label} ${label} variant`.toLowerCase(),
            spec: { componentId: e.componentId, variants: { [axis]: option } },
            variant: { option: label, axis: a.label },
            preview: file ? { pack: theme.id, file } : undefined
          };
        })
    );
    // The theme's default look, named where its options have names of their own (Page introduction: Soft background).
    const named = axes.map(([, a]) => a.options[a.default]?.label).filter((l): l is string => !!l && l.trim().toLowerCase() !== 'default');
    const shipped: Item = { ...base, hay: `${base.hay} theme default ${named.join(' ')}`.toLowerCase().trim(), ...(named.length ? { defaults: named.join(' · ') } : {}) };
    return [shipped, ...options];
  });
  const elements: Item[] = BASICS.map((b) => ({ key: `e:${b.id}`, kind: 'element', name: b.name, description: '', hay: basicHay(b), group: 'Basic elements', spec: basicSpec(b), icon: b.icon }));
  // Code components show only in Developer mode, as its setting promises. The library reads by name, and a separate
  // copy (Make unique) sits under the component it was copied from, so a family stays together.
  const defs = Object.values(st.components).filter((d) => d.owner === 'project' && d.category !== 'shell' && (dev || d.kind !== 'code'));
  const listed = new Set(defs.map((d) => d.id));
  const byName = (a: ComponentDefinition, b: ComponentDefinition) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  // The nearest listed component a copy was made from, through copies of copies.
  const sourceOf = (d: ComponentDefinition) => {
    const seen = new Set<string>();
    for (let f = d.provenance?.forkedFrom; f && !seen.has(f); f = st.components[f]?.provenance?.forkedFrom) {
      if (listed.has(f)) return f;
      seen.add(f);
    }
    return undefined;
  };
  const copies = new Map<string, ComponentDefinition[]>();
  for (const d of defs) {
    const from = sourceOf(d);
    if (from) copies.set(from, [...(copies.get(from) ?? []), d]);
  }
  const familyOrder: Array<[ComponentDefinition, 0 | 1]> = [];
  const visit = (d: ComponentDefinition, depth: 0 | 1) => {
    familyOrder.push([d, depth]);
    for (const c of (copies.get(d.id) ?? []).sort(byName)) visit(c, 1);
  };
  for (const d of defs.filter((d) => !sourceOf(d)).sort(byName)) visit(d, 0);
  const mine: Item[] = familyOrder.flatMap(([d, depth]): Item[] => {
    const from = d.provenance?.forkedFrom ? st.components[d.provenance.forkedFrom] : undefined;
    const copyOf = from?.owner === 'project' ? from.name : undefined;
    const themeCopy = from?.owner === 'theme' ? from.name : undefined;
    const usage = usageOf(st, d.id);
    const base: Item = {
      key: `c:${d.id}`,
      kind: 'component',
      name: d.name,
      description: d.description ?? '',
      hay: `${d.name} ${d.description ?? ''} ${d.kind === 'code' ? 'code ' : ''}component ${copyOf ? `copy ${copyOf}` : ''} ${themeCopy ? `theme copy ${themeCopy}` : ''} ${usage.status === 'unused' ? 'unused' : ''}`.toLowerCase(),
      group: 'Your components',
      spec: { definitionId: d.id },
      code: d.kind === 'code',
      uses: usage.count,
      usage,
      depth,
      ...(copyOf ? { copyOf } : {}),
      ...(themeCopy ? { themeCopy } : {})
    };
    if (!showVariants) return [base];
    // In Variants, a component's own options follow it, each inserting (and previewing) with that option chosen; the
    // component's own row names the look it has by default.
    const options = axesOf(d).flatMap(([axis, a]) =>
      Object.entries(a.options)
        .filter(([option]) => option !== a.default)
        .map(([option, o]): Item => {
          const label = o.label.trim().toLowerCase() === 'default' ? `Default ${a.label.toLowerCase()}` : o.label;
          return { ...base, key: `${base.key}~${axis}=${option}`, hay: `${base.hay} ${a.label} ${label} option variant`.toLowerCase(), spec: { definitionId: d.id, variants: { [axis]: option } }, variant: { option: label, axis: a.label }, depth: 1 };
        })
    );
    const named = axesOf(d)
      .map(([, a]) => a.options[a.default]?.label)
      .filter((l): l is string => !!l && l.trim().toLowerCase() !== 'default');
    return [options.length && named.length ? { ...base, defaults: named.join(' · '), hay: `${base.hay} ${named.join(' ')}`.toLowerCase() } : base, ...options];
  });

  const byKey = new Map([...mine, ...sections, ...elements].map((it) => [it.key, it]));

  const query = q.toLowerCase().trim();
  // A section in Variants is ranked by the name it shows ("Centered hero Dark"), and by its own name, so typing the
  // section's name still finds it first.
  const shown = (it: Item) => ((it.kind === 'section' && showVariants) || it.variant ? `${it.name} ${optionLabel(it)}` : it.name);
  const results = searchItems([...mine, ...sections, ...elements], query, shown);
  const current = results[Math.min(active, results.length - 1)];

  const sectionAt = insertionPoint('section');
  const elementAt = insertionPoint('element');
  const sectionTo = sectionWhere(st, sectionAt);
  const elementTo = elementWhere(st, elementAt);
  // A project component goes where it was made to go: beside the page's sections, or into the selected layout like an
  // element (a second card beside the selected one, in its grid).
  const plans = new Map<string, { role: InsertRole; at: InsertAt | null; where: Where }>();
  const planOf = (it: Item) => {
    let p = plans.get(it.key);
    if (!p) {
      const { role, at } = it.kind === 'section' ? { role: 'section' as const, at: sectionAt } : it.kind === 'element' ? { role: 'element' as const, at: elementAt } : insertPlan(it.spec, snap);
      p = { role, at, where: it.kind === 'section' ? sectionTo : it.kind === 'element' ? elementTo : whereFor(st, at, role) };
      plans.set(it.key, p);
    }
    return p;
  };
  const whereOf = (it: Item): Where => planOf(it).where;
  // Components as a group go to one place only when each of them does.
  const componentTo = mine.length && mine.every((it) => sameWhere(whereOf(it), whereOf(mine[0]))) ? whereOf(mine[0]) : null;
  const where: Record<Kind, Where> = { section: sectionTo, element: elementTo, component: componentTo };
  const topKind: Kind = mine.length || dev ? 'component' : 'section';

  // One insert at a time: a second click or Enter before the first has landed would read the same insertion point
  // and put both in one place.
  const add = async (it: Item) => {
    if (adding.current) return;
    adding.current = true;
    clearTimeout(peekTimer.current);
    setPeek(null);
    try {
      const to = whereOf(it);
      const before = getState().selection;
      const prior = getState().snapshot;
      const project = prior?.workspaceKey;
      const known = getState().snapshot?.history.entries.map((e) => e.id) ?? [];
      const name = fullName(it);
      await insert(it.spec, name);
      const s = getState();
      const after = s.selection;
      // Landed: the selection moved to a node of this project that exists now and did not before the insert.
      const landed = !!(after && after !== before && s.snapshot && s.snapshot.workspaceKey === project && treeFor(s.snapshot.state, after.owner)?.nodes[after.nodeId] && !(prior && treeFor(prior.state, after.owner)?.nodes[after.nodeId]));
      if (!landed || !after) return;
      setAdded((a) => ({ key: it.key, kind: it.kind, name, where: to, n: (a?.n ?? 0) + 1, selection: after, known }));
      if (stripRef.current?.matches(':hover')) setHoldPointer(true);
    } finally {
      adding.current = false;
    }
  };
  // The insert's own history entry, while it is still applied: what the confirmation's Undo takes back.
  const addedEntry = added && snap.history.entries.find((e) => e.applied && e.label === `Insert ${added.name}` && !added.known.includes(e.id));
  const undo = addedEntry ? undoAction({ entryId: addedEntry.id, revision: snap.revision, workspaceKey: snap.workspaceKey }) : undefined;
  const undoKeys = api.platform === 'darwin' ? '⌘Z' : 'Ctrl+Z';
  const clear = () => {
    setQ('');
    searchRef.current?.focus();
  };
  // Escape anywhere in the panel clears a search first, before the editor's own Escape (deselect) runs.
  const onPanelKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented) return;
    // While browsing, Escape first puts away the larger preview and leaves focus on its tile.
    if (e.key === 'Escape' && peek && !q) {
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(peekTimer.current);
      dismissed.current = peek.key;
      setPeek(null);
      return;
    }
    if (e.key === 'Escape' && q && !(e.target as HTMLElement).closest('.insert-body [role="grid"]')) {
      e.preventDefault();
      e.stopPropagation();
      clear();
    }
  };
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // The highlighted saved component's own menu, from the keyboard, as right-click opens it.
    if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && current?.kind === 'component') {
      e.preventDefault();
      const row = document.getElementById(`${id}-r${results.indexOf(current)}`);
      const box = row?.getBoundingClientRect();
      if (box) menu.open(box.left + 24, box.bottom - 4, manage(current), `Manage ${current.name}`, searchRef.current);
      return;
    }
    // Text editing, IME composition and modified keys stay with the field.
    if (e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key === 'Escape' && q && peek) {
      // The preview goes first; the search and its highlight stay.
      e.preventDefault();
      e.stopPropagation();
      clearTimeout(peekTimer.current);
      dismissed.current = peek.key;
      setPeek(null);
    } else if (e.key === 'Escape' && q) {
      e.preventDefault();
      setQ('');
    } else if (e.key === 'Enter' && current) {
      e.preventDefault();
      // Scrolled out of view, the highlighted result is shown first rather than added unseen.
      const row = document.getElementById(`${id}-r${results.indexOf(current)}`);
      const box = row?.getBoundingClientRect();
      const view = bodyRef.current?.getBoundingClientRect();
      if (row && box && view && (box.top < view.top - 1 || box.bottom > view.bottom + 1)) {
        row.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (!e.repeat) void add(current);
    } else if (query && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((a) => Math.max(0, Math.min(results.length - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
      setReveal((r) => r + 1);
    } else if (!query && e.key === 'ArrowDown') {
      // Down from an empty search goes into the palette.
      e.preventDefault();
      bodyRef.current?.querySelector<HTMLElement>('[role="gridcell"] > [tabindex="0"]')?.focus();
    }
  };
  // The larger preview opens after a short rest on a tile, and moves straight to the next tile once it is open.
  const showPeek = (key: string, el: HTMLElement, wait: number) => {
    clearTimeout(peekTimer.current);
    const go = () => el.isConnected && setPeek({ key, rect: el.getBoundingClientRect() });
    if (wait && !peek) peekTimer.current = setTimeout(go, wait);
    else go();
  };
  // Long enough to cross from the tile onto the preview, which keeps it open (and the strip on its tile) while the
  // pointer is on it.
  const hidePeek = (key?: string, wait = 200) => {
    clearTimeout(peekTimer.current);
    peekTimer.current = setTimeout(() => {
      setPointed(null);
      // Searching, the preview belongs to the highlighted result, which the field still has.
      if (document.activeElement === searchRef.current && searchRef.current?.value.trim()) return;
      // A section that still has keyboard focus gets its preview back once the pointer has gone.
      const f = document.activeElement as HTMLElement | null;
      if (f && bodyRef.current?.contains(f) && peekable(f.dataset.kind) && f.matches(':focus-visible') && f.dataset.key !== dismissed.current) setPeek({ key: f.dataset.key!, rect: f.getBoundingClientRect() });
      else setPeek((p) => (key === undefined || p?.key === key ? null : p));
    }, wait);
  };
  const keepPeek = () => clearTimeout(peekTimer.current);
  // The strip above the list follows the tile under the pointer or the keyboard, so it always says where
  // the thing you are about to add will go.
  const onBodyFocus = (e: React.FocusEvent<HTMLElement>) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[role="gridcell"] > *');
    if (!cell) return;
    for (const c of cell.closest('[role="grid"]')?.querySelectorAll<HTMLElement>('[role="gridcell"] > *') ?? []) {
      if (c === cell) c.dataset.rove = '1';
      else delete c.dataset.rove;
      c.tabIndex = c === cell ? 0 : -1;
    }
    setPointed(null);
    setFocused(cell.dataset.key || null);
    clearTimeout(peekTimer.current);
    if (cell.dataset.key !== dismissed.current) dismissed.current = null;
    if (peekable(cell.dataset.kind) && cell.matches(':focus-visible') && cell.dataset.key !== dismissed.current) showPeek(cell.dataset.key!, cell, 0);
    else setPeek(null);
  };
  const onBodyBlur = (e: React.FocusEvent<HTMLElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setFocused(null);
    if (!searching) hidePeek();
  };
  const onBodyScroll = (e: React.UIEvent<HTMLElement>) => {
    const body = e.currentTarget;
    // The preview follows a tile or result that is still in view (keyboard focus scrolls its tile into view), and
    // goes when its tile scrolls away.
    if (peek) {
      const anchor = searching ? document.getElementById(`${id}-r${active}`) : body.querySelector<HTMLElement>(`[data-key="${CSS.escape(peek.key)}"]`);
      const box = anchor?.getBoundingClientRect();
      const view = body.getBoundingClientRect();
      const held = anchor && (searching || anchor === document.activeElement);
      if (held && box && box.bottom > view.top && box.top < view.bottom) setPeek({ key: peek.key, rect: box });
      else setPeek(null);
    }
    if (searching) return;
    browseTop.current = body.scrollTop;
    // At the very top the first group speaks; scrolled to the end, the last one does (it may never reach the top).
    let k: Kind | null = null;
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) k = (body.querySelector<HTMLElement>('.insert-group[data-kind="element"]') ? 'element' : null);
    else if (body.scrollTop > 4) {
      const top = body.getBoundingClientRect().top + 24;
      const group = [...body.querySelectorAll<HTMLElement>('.insert-group')].find((g) => g.getBoundingClientRect().bottom > top);
      k = (group?.dataset.kind as Kind) || null;
    }
    if (k !== scrolled) setScrolled(k);
  };
  const jumpToElements = () => {
    const g = bodyRef.current?.querySelector<HTMLElement>('.insert-group[data-kind="element"]');
    if (!g) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    g.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
    const cell = g.querySelector<HTMLElement>('[role="gridcell"] > [tabindex="0"]');
    cell?.focus({ preventScroll: true });
    // A remembered tile further down the group must end up on screen too.
    if (cell) setTimeout(() => cell.scrollIntoView({ block: 'nearest' }), smooth ? 350 : 0);
  };
  // With a preview open, a section tile crossed on the way to it takes a moment to replace it, so the pointer can
  // reach the preview it opened.
  const hover = (key: string, section = false) => ({
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      // A tile being dragged to the canvas crosses others on its way: they open nothing.
      if (document.documentElement.classList.contains('insert-dragging')) return;
      const el = e.currentTarget;
      if (dismissed.current !== key) dismissed.current = null;
      if (dismissed.current === key) return setPointed(key);
      if (section && peek) {
        clearTimeout(peekTimer.current);
        peekTimer.current = setTimeout(() => {
          if (!el.isConnected) return;
          setPointed(key);
          setPeek({ key, rect: el.getBoundingClientRect() });
        }, 140);
        return;
      }
      if (!section) {
        clearTimeout(peekTimer.current);
        setPeek(null);
      }
      setPointed(key);
      if (section) showPeek(key, el, 320);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      // Heading right, toward the preview beside the panel, gets time to cross the gap.
      if (section) hidePeek(key, e.clientX >= e.currentTarget.getBoundingClientRect().right - 2 ? 500 : 200);
      else setPointed((p) => (p === key ? null : p));
    }
  });
  const descId = (it: Item) => `${id}-d-${it.key}`;
  const describedBy = (it: Item) => `${id}-to-${it.kind === 'component' ? it.key : it.kind}${it.description || it.usage ? ` ${descId(it)}` : ''}`;
  // A saved component's description also says, in full, where it is used: the row shows only the start of it.
  const usageText = (u?: Usage) => (!u ? '' : u.status === 'used' ? `${u.short}: ${u.places.join(', ')}.` : u.status === 'needed' ? 'Not placed, but needed by code.' : 'Not used anywhere.');
  const description = (it: Item) =>
    it.description || it.usage ? (
      <span hidden id={descId(it)}>
        {[it.description, it.variant && it.usage ? `The component: ${usageText(it.usage)}` : usageText(it.usage)].filter(Boolean).join(' ')}
      </span>
    ) : null;
  // A tile or result pressed and moved a few pixels is dragged onto the canvas, which shows where it would land; the
  // click that ends a drag adds nothing more. A click, Enter or Space still adds it where the strip says.
  const dragFrom = (it: Item) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      dragged.current = false;
      if (e.button !== 0 || !e.isPrimary || e.pointerType === 'touch') return;
      const from = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
      const stop = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', stop, true);
        window.removeEventListener('pointercancel', stop, true);
        window.removeEventListener('blur', stop);
      };
      const move = (ev: PointerEvent) => {
        if (ev.pointerId !== from.pointer || Math.hypot(ev.clientX - from.x, ev.clientY - from.y) < DRAG_START) return;
        stop();
        // One insert at a time, as for a click.
        if (adding.current || !beginInsertDrag({ spec: it.spec, name: fullName(it) }, { x: ev.clientX, y: ev.clientY, pointerId: ev.pointerId })) return;
        dragged.current = true;
        window.getSelection()?.removeAllRanges();
        clearTimeout(peekTimer.current);
        setPeek(null);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      window.addEventListener('blur', stop);
    },
    onDragStart: (e: React.DragEvent<HTMLElement>) => e.preventDefault()
  });
  /** Whether a click ends a drag. A keyboard's click never does, and leaves the drag's own click to be told apart. */
  const endsDrag = (e: React.MouseEvent<HTMLElement>) => {
    if (e.detail === 0) return false;
    const was = dragged.current;
    dragged.current = false;
    return was;
  };
  const tileProps = (it: Item) => ({
    'data-kind': it.kind,
    'data-key': it.key,
    'aria-describedby': describedBy(it),
    onClick: (e: React.MouseEvent<HTMLElement>) => !endsDrag(e) && void add(it),
    ...dragFrom(it),
    ...hover(it.key, peekable(it.kind))
  });
  const justAdded = (it: Item) => added?.key === it.key;
  const badge = (it: Item) => (
    <span className="insert-add" aria-hidden="true">
      {justAdded(it) ? <Check /> : <Plus />}
    </span>
  );
  const iconFor = (it: Item) =>
    justAdded(it) ? (
      <span className="ico done">
        <Check />
      </span>
    ) : (
      <ItemIcon it={it} />
    );
  // The library's own menu, named for the component it manages: rename, edit the design everywhere (or its code), go
  // to each placement (choosing one shows it), and delete once unused.
  const manageItems = (def: ComponentDefinition): MenuItem[] => {
    const places = placesOf(st, def.id);
    const needs = dependentsOf(st, def.id);
    const count = places.reduce((n, p) => n + p.nodeIds.length, 0);
    // Pages that share a title are told apart by their address.
    const titles = places.filter((p) => p.owner.kind === 'page').map((p) => p.label);
    const pageLabel = (p: (typeof places)[number]) => (titles.indexOf(p.label) !== titles.lastIndexOf(p.label) ? `${p.label} (${st.pages[p.owner.id]?.route ?? ''})` : p.label);
    // Each placement is its own item, so the one chosen is the one shown; several on one place are counted in order.
    const placeItems = (p: (typeof places)[number]): MenuItem[] => {
      if (p.owner.kind === 'component') return [{ label: `In ${p.label}`, icon: <Component />, hint: p.nodeIds.length > 1 ? `${p.nodeIds.length} times` : 'Design', disabled: true }];
      const label = p.owner.kind === 'page' ? pageLabel(p) : p.owner.kind === 'template' ? p.label : `Shared ${p.label.toLowerCase()}`;
      const icon = p.owner.kind === 'page' ? <FileText /> : p.owner.kind === 'template' ? <LayoutTemplate /> : p.owner.id === 'footer' ? <PanelBottom /> : <PanelTop />;
      if (p.nodeIds.length === 1) return [{ label, icon, onSelect: () => void showPlacement(def.id, p.owner, p.nodeIds[0]) }];
      // Several on one page: in the order they appear, each named by where it sits.
      const tree = treeFor(st, p.owner);
      const order = tree ? documentOrder(tree) : [];
      const ids = [...p.nodeIds].sort((a, b) => order.indexOf(a) - order.indexOf(b));
      return ids.map((nodeId, i) => ({ label: tree ? `${label} · ${whereIn(st, p.owner, tree, nodeId)}` : label, icon, hint: `${i + 1} of ${ids.length}`, onSelect: () => void showPlacement(def.id, p.owner, nodeId) }));
    };
    const onPage = places.some((p) => p.owner.kind !== 'component');
    // Component Studio shows any component on its own, placed or not (issue #367); Edit everywhere shows it on a page.
    const studio: MenuItem = { label: 'Open in Component Studio', icon: <SquareDashed />, hint: count ? undefined : 'Not placed yet', onSelect: () => void openComponentStudio(def.id) };
    const edit: MenuItem[] =
      def.kind === 'code'
        ? [studio, ...(dev ? [{ label: 'Edit code', icon: <FileCode2 />, onSelect: () => setState({ modal: { kind: 'source', definitionId: def.id } }) }] : [])]
        : [studio, ...(onPage ? [{ label: 'Edit everywhere', icon: <Component />, hint: 'On a page', onSelect: () => editEverywhere(def.id) }] : [])];
    const from = def.provenance?.forkedFrom ? st.components[def.provenance.forkedFrom] : undefined;
    const source = from?.owner === 'project' ? `Copy of ${from.name}` : from?.owner === 'theme' ? `Copy of the theme’s ${from.name}` : null;
    return [
      { heading: def.name },
      ...(source ? [{ heading: source }] : []),
      { label: 'Rename', icon: <Pencil />, onSelect: () => setState({ modal: { kind: 'rename-component', definitionId: def.id } }) },
      ...edit,
      { label: 'Export…', icon: <Download />, hint: 'For another site', onSelect: () => void exportDefinition(def) },
      { separator: true },
      { heading: count ? `Used ${usedTimes(count)}` : needs.length ? 'Not placed anywhere' : 'Not used anywhere' },
      ...places.flatMap(placeItems),
      ...needs.map((d): MenuItem => ({ label: `Needed by ${d.name}`, icon: <Code />, hint: 'Code', disabled: true })),
      { separator: true },
      { label: 'Delete component', icon: <Trash2 />, danger: true, disabled: count > 0 || needs.length > 0, hint: count || needs.length ? 'In use' : undefined, onSelect: () => void removeDefinition(def) }
    ];
  };
  const removeDefinition = async (def: ComponentDefinition) => {
    const rows = [...(bodyRef.current?.querySelectorAll<HTMLElement>('.insert-group[data-kind="component"] .insert-tile.project') ?? [])];
    refocus.current = { id: def.id, index: Math.max(0, rows.findIndex((r) => r.dataset.key === `c:${def.id}`)) };
    const r = await commitOps([{ type: 'component.remove', definitionId: def.id }], `Delete component ${def.name}`);
    if (!r) refocus.current = null;
    if (!r || getState().snapshot?.workspaceKey !== r.workspaceKey) return;
    toast(`Deleted ${def.name}`, 'info', undoAction(r));
  };
  // A package file another project can import: the chooser and the writing happen in the app.
  const exportDefinition = async (def: ComponentDefinition) => {
    const r: ComponentExportResult = await api.project.exportComponent(def.id).catch((e: Error) => ({ ok: false, message: `${def.name} couldn’t be exported: ${e.message}` }));
    if (r.ok) toast([`Exported ${def.name}.`, ...(r.notes ?? [])].join(' '), 'info');
    else if (r.message) toast(r.message, 'error');
  };
  const importPackage = async () => {
    const workspaceKey = getState().snapshot?.workspaceKey;
    const r: ComponentImportResult = await api.project.importComponent().catch((e: Error) => ({ ok: false, message: `The component couldn’t be imported: ${e.message}` }));
    if (!r.ok) {
      if (r.message) toast(r.message, 'error');
      return;
    }
    toast(`Imported ${r.name ?? 'the component'}`, 'info', workspaceKey && r.revision !== undefined ? undoAction({ entryId: r.entryId, revision: r.revision, workspaceKey }) : undefined);
  };
  const manage = (it: Item) => {
    const def = st.components[it.spec.definitionId!];
    menuFor.current = def?.id ?? null;
    return def ? manageItems(def) : [];
  };

  const groups = new Map<string, Item[]>();
  for (const it of sections) groups.set(it.group, [...(groups.get(it.group) ?? []), it]);
  // In Variants each section's options sit together, under the section's name.
  const bandsOf = (list: Item[]) => {
    const bands: Array<{ key: string; label: string; items: Item[] }> = [];
    for (const it of list) {
      const last = bands.at(-1);
      if (last && last.key === it.spec.componentId) last.items.push(it);
      else bands.push({ key: it.spec.componentId!, label: it.name, items: [it] });
    }
    return bands;
  };
  const found = query ? (results.length ? `${results.length} result${results.length === 1 ? '' : 's'} for ${q.trim()}` : `No matches for ${q.trim()}`) : '';
  const confirmed = added ? `Added ${added.name} ${added.where?.lead ?? ''} ${added.where ? placeText(added.where) : ''}` : '';

  // What the strip says next: the item about to be added and where it goes, else where the next one goes.
  // Under a confirmation there is room for one short line, so it names only the place: the tile in view says what.
  const aim = query ? (current?.key ?? null) : (pointed ?? focused);
  const aimItem = aim && aim !== 'new' && aim !== 'new-component' ? byKey.get(aim) : undefined;
  const next = !!added;
  const fallback: Kind = next ? added.kind : query ? 'section' : (scrolled ?? topKind);
  // The next one of what was just added goes where that item now goes, from the new selection.
  const addedItem = added ? byKey.get(added.key) : undefined;
  const nextTo = next ? (aimItem ? whereOf(aimItem) : addedItem ? whereOf(addedItem) : where[added.kind]) : null;
  const aimTo = aimItem ? whereOf(aimItem) : null;
  const line: Line =
    aim === 'new'
      ? { verb: 'Opens the code editor to write a new component' }
      : aim === 'new-component'
        ? { verb: 'Starts a new component, blank or built by AI' }
      : next && nextTo
        ? { verb: `Next: ${nextTo.lead.replace(/^in a new section /, 'new section ')}`, target: placeText(nextTo), full: `The next one goes ${nextTo.lead} ${placeText(nextTo)}` }
        : aimItem && aimTo
          ? { name: fullName(aimItem), verb: placeLead(aimTo.lead), target: placeText(aimTo), full: `${fullName(aimItem)} goes ${aimTo.lead} ${placeText(aimTo)}` }
          : where[fallback]
            ? { verb: `${KIND_SUBJECT[fallback]} ${where[fallback]!.lead}`, target: placeText(where[fallback]!) }
            : fallback === 'component' && mine.length
              ? { verb: 'Point at a component to see where it goes' }
              : { verb: '' };

  const peekItem = peek && byKey.get(peek.key);
  const panelRect = peekItem ? bodyRef.current?.closest('.side-panel')?.getBoundingClientRect() : undefined;

  const newComponent = (
    <button className="insert-tile new" data-kind="new" data-key="new-component" onClick={() => setState({ modal: { kind: 'new-component' } })} {...hover('new-component')}>
      <span className="ico">
        <Plus />
      </span>
      <strong>Create component</strong>
    </button>
  );
  const newCode = dev && (
    <button className="insert-tile new" data-kind="new" data-key="new" onClick={() => setState({ modal: { kind: 'new-code' } })} {...hover('new')}>
      <span className="ico">
        <Plus />
      </span>
      <strong>New code component</strong>
    </button>
  );
  const importTile = (
    <button className="insert-tile new" data-kind="import" data-key="import" onClick={() => void importPackage()}>
      <span className="ico">
        <Upload />
      </span>
      <strong>Import component…</strong>
    </button>
  );
  // Four components before Show all; a component's own options (in Variants) come with it.
  const components = mine.filter((it) => !it.variant).length;
  let counted = 0;
  const shownMine = allMine ? mine : mine.filter((it) => (it.variant ? counted <= MINE_SHOWN : ++counted <= MINE_SHOWN));
  // The unused components Show all would reveal.
  const unusedCount = mine.filter((it) => !it.variant && it.usage?.status === 'unused' && !shownMine.includes(it)).length;
  const showAll = components > MINE_SHOWN && (
    <button className="btn btn-sm btn-ghost insert-more" aria-expanded={allMine} onClick={() => setAllMine(!allMine)}>
      <ChevronDown aria-hidden="true" />
      {allMine ? 'Show fewer' : `Show all ${components} components`}
      {!allMine && unusedCount > 0 && <span className="insert-more-note">{unusedCount} not used</span>}
    </button>
  );
  /** A saved component's picture, marked as a component or code, or as just added. */
  const libraryPic = (it: Item) => {
    const def = st.components[it.spec.definitionId!];
    if (it.variant)
      return (
        <span className={`insert-lib-opt${justAdded(it) ? ' done' : ''}`} aria-hidden="true">
          {justAdded(it) ? <Check /> : <SwatchBook />}
        </span>
      );
    return (
      <span className="insert-lib-pic">
        {def && <ComponentThumb definitionId={def.id} active={open} fallback={<DesignSketch def={def} st={st} />} />}
        <span className={`insert-lib-mark${justAdded(it) ? ' done' : ''}`} aria-hidden="true">
          {justAdded(it) ? <Check /> : it.code ? <Code /> : <Component />}
        </span>
      </span>
    );
  };
  /** What a row says under its name: its option's axis, else whether and where it is used. */
  const libraryMeta = (it: Item) => {
    if (it.variant) return `${it.variant.axis} option`;
    const u = it.usage;
    // Where it is used comes first; in Variants, the look it has by default; a theme copy says so once it has no place to name.
    const after = u?.status === 'used' ? u.where : it.copyOf ? `Copy of ${it.copyOf}` : it.themeCopy ? 'Theme copy' : '';
    return (
      <>
        {u?.status === 'used' ? <span className="use">{u.short}</span> : <span className="insert-lib-chip">{u?.short ?? 'Not used'}</span>}
        <Where text={after} />
      </>
    );
  };
  const libraryWho = (it: Item) =>
    [it.code ? 'code component' : 'component', it.variant ? `${it.variant.axis.toLowerCase()} option of ${it.name}` : '', it.copyOf ? `copy of ${it.copyOf}` : '', it.themeCopy ? `copy of the theme's ${it.themeCopy} section` : ''].filter(Boolean).join(', ');
  const yours = (
    <section className="insert-group" data-kind="component" aria-labelledby={`${id}-yours`}>
      <h4 className="insert-head" id={`${id}-yours`}>
        Your components
        {components > 0 && <span className="count">{components}</span>}
      </h4>
      {!components && (
        <div className="insert-lib-empty">
          <span className="ico" aria-hidden="true">
            <Component />
          </span>
          <span className="txt">
            <strong>Reuse what you design</strong>
            <span>
              Start one below, or right-click a group on the page and choose <b>Create component</b>. It appears here, ready to add to any page.
            </span>
          </span>
        </div>
      )}
      <TileGrid
        items={shownMine}
        labelledBy={`${id}-yours`}
        className="compact list managed"
        cols={1}
        extra={[showAll, newComponent, newCode, importTile].filter(Boolean) as ReactNode[]}
        render={(it) => (
          <button
            className={`insert-tile project${it.depth ? ' sub' : ''}${it.variant ? ' option' : ''}${justAdded(it) ? ' just-added' : ''}`}
            title={it.variant ? `${it.name}: ${it.variant.option}` : [it.name, it.copyOf ? `copy of ${it.copyOf}` : it.themeCopy ? `copy of the theme's ${it.themeCopy}` : '', it.description].filter(Boolean).join(' — ')}
            {...tileProps(it)}
            onContextMenu={(e) => {
              e.preventDefault();
              menu.open(e.clientX, e.clientY, manage(it), `Manage ${it.name}`, e.currentTarget);
            }}
          >
            {!!it.depth && !it.variant && <CornerDownRight className="insert-lib-branch" aria-hidden="true" />}
            {libraryPic(it)}
            <span className="txt">
              <strong>{it.variant ? it.variant.option : it.name}</strong>
              <small className="insert-lib-meta">{libraryMeta(it)}</small>
              {showVariants && it.defaults && !it.variant && <small className="insert-defaults">Default: {it.defaults}</small>}
              <span className="sr-only">, {libraryWho(it)}</span>
            </span>
            {badge(it)}
            {description(it)}
          </button>
        )}
        aside={(it) =>
          it.variant ? null : (
            <button className="icon-btn insert-manage" aria-haspopup="menu" aria-expanded="false" aria-label={`Manage ${it.name}`} title="Rename, edit, see where it is used, or delete" onClick={(e) => menu.openAt(e.currentTarget, manage(it), `Manage ${it.name}`)}>
              <Ellipsis />
            </button>
          )
        }
      />
    </section>
  );

  return (
    <div className={`insert-panel${narrow ? ' narrow' : ''}`} onKeyDown={onPanelKey}>
      {menu.node}
      <div className="panel-head">
        <h3>Insert</h3>
        <button className="btn btn-sm btn-ghost insert-variants" aria-pressed={showVariants} aria-label={narrow ? 'Variants' : undefined} title="List each section's and component's variants (tone, layout) as their own items" onClick={toggleVariants}>
          <SwatchBook aria-hidden="true" />
          <span className="lbl">Variants</span>
        </button>
        {!query && (
          <button className="btn btn-sm btn-ghost insert-jump" title="Jump to the basic elements" onClick={jumpToElements}>
            <ArrowDown aria-hidden="true" />
            <span className="lbl">Elements</span>
          </button>
        )}
      </div>
      <div className="search insert-search">
        <Search aria-hidden="true" />
        <input
          ref={searchRef}
          className="input"
          role="combobox"
          aria-expanded={!!query && results.length > 0}
          aria-controls={query && results.length ? `${id}-results` : undefined}
          aria-autocomplete="list"
          aria-activedescendant={query && current ? `${id}-r${results.indexOf(current)}` : undefined}
          placeholder="Search items to add"
          aria-label="Search items to add"
          value={q}
          spellCheck={false}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onSearchKey}
          onFocus={() => {
            setTyping(true);
            peekResult();
          }}
          onBlur={() => {
            setTyping(false);
            if (query) setPeek(null);
          }}
        />
        {q && (
          <button className="icon-btn sm insert-clear" aria-label="Clear search" title="Clear search (Esc)" onClick={clear}>
            <X />
          </button>
        )}
      </div>
      <div
        ref={stripRef}
        className={`insert-where${added ? ' added' : ''}`}
        onMouseEnter={() => added && setHoldPointer(true)}
        onMouseLeave={() => setHoldPointer(false)}
        onFocus={() => added && setHoldFocus(true)}
        onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setHoldFocus(false)}
      >
        {added && (
          <div className="insert-where-done" key={added.n}>
            <Check aria-hidden="true" />
            <span className="txt" title={confirmed}>
              Added <b>{added.name}</b>
            </span>
            {undo && (
              <button
                className="btn btn-sm btn-ghost insert-undo"
                aria-label={`Undo adding ${added.name}`}
                title={`Undo adding ${added.name} (${undoKeys})`}
                onClick={() => {
                  undo.run();
                  setAdded(null);
                  searchRef.current?.focus({ preventScroll: true });
                }}
              >
                <Undo2 aria-hidden="true" />
                <span className="lbl">Undo</span>
              </button>
            )}
          </div>
        )}
        <div className="insert-where-next" title={lineText(line) || undefined}>
          <CornerDownRight aria-hidden="true" />
          <span className={`txt${next || line.name ? ' split' : ''}`}>
            <LineText line={line} row={next} />
          </span>
          {query && current && typing && (
            <kbd className="kbd" title="Enter adds it">
              ↵
            </kbd>
          )}
        </div>
      </div>
      <p className="sr-only" role="status">
        {found}
      </p>
      <p className="sr-only" role="status">
        {confirmed}
        {added && added.n % 2 ? '\u00a0' : ''}
      </p>
      {(['section', 'element'] as const).map((k) => (
        <span key={k} id={`${id}-to-${k}`} hidden>
          {where[k] ? `${KIND_SUBJECT[k]} ${where[k]!.lead} ${placeText(where[k]!)}` : ''}
        </span>
      ))}
      {mine.map((it) => {
        const w = whereOf(it);
        return (
          <span key={it.key} id={`${id}-to-${it.key}`} hidden>
            {w ? `Goes ${w.lead} ${placeText(w)}` : ''}
          </span>
        );
      })}
      <div className="panel-body insert-body" ref={bodyRef} onKeyDown={gridKeys} onFocus={onBodyFocus} onBlur={onBodyBlur} onScroll={onBodyScroll}>
        {query ? (
          results.length ? (
            <div className="insert-results" role="listbox" id={`${id}-results`} aria-label="Results" onMouseLeave={(e) => document.activeElement !== searchRef.current && hidePeek(undefined, e.clientX >= e.currentTarget.getBoundingClientRect().right - 2 ? 500 : 200)}>
              {results.map((it, i) => (
                <div
                  key={it.key}
                  id={`${id}-r${i}`}
                  role="option"
                  data-kind={it.kind}
                  data-key={it.key}
                  aria-selected={it === current}
                  aria-describedby={describedBy(it)}
                  className={`insert-result${it === current ? ' active' : ''}`}
                  title={it.kind !== 'section' && it.description ? it.description : undefined}
                  onMouseDown={(e) => e.preventDefault()}
                  onContextMenu={
                    it.kind === 'component'
                      ? (e) => {
                          e.preventDefault();
                          menu.open(e.clientX, e.clientY, manage(it), `Manage ${it.name}`, searchRef.current);
                        }
                      : undefined
                  }
                  onMouseMove={() => !document.documentElement.classList.contains('insert-dragging') && (i !== active ? setActive(i) : !peek && peekResult())}
                  {...dragFrom(it)}
                  onClick={(e) => {
                    searchRef.current?.focus({ preventScroll: true });
                    if (!endsDrag(e)) void add(it);
                  }}
                >
                  {it.kind === 'section' ? (
                    <span className="insert-thumb" aria-hidden="true">
                      <SectionThumb it={it} />
                    </span>
                  ) : it.kind === 'component' ? (
                    libraryPic(it)
                  ) : (
                    iconFor(it)
                  )}
                  <span className="txt">
                    <strong>{(it.kind === 'section' && showVariants) || it.variant ? `${it.name} · ${optionLabel(it)}` : it.name}</strong>
                    <small>
                      {it.kind === 'section'
                        ? it.variant
                          ? `${it.group} · ${it.variant.axis}`
                          : showVariants && it.defaults
                            ? `${it.group} · ${it.defaults}`
                            : it.group
                        : it.kind === 'element'
                          ? 'Basic element'
                          : (
                            <span className="insert-lib-meta">
                              <span className="use">{[it.code ? 'Code' : '', it.variant ? `${it.variant.axis} option` : (it.usage?.short ?? '')].filter(Boolean).join(' · ')}</span>
                              {!it.variant && <Where text={it.usage?.status === 'used' ? it.usage.where : it.themeCopy ? 'Theme copy' : it.copyOf ? `Copy of ${it.copyOf}` : ''} />}
                            </span>
                          )}
                    </small>
                    {it.kind === 'component' && <span className="sr-only">, {libraryWho(it)}. Shift F10 to manage it</span>}
                  </span>
                  {description(it)}
                </div>
              ))}
            </div>
          ) : (
            <div className="insert-none">
              <SearchX aria-hidden="true" />
              <strong>Nothing matches “{q.trim()}”</strong>
              <span>Try a shorter or more general word, like “text”, “image” or “contact”.</span>
              <button className="btn btn-sm" onClick={clear}>
                Clear search
              </button>
            </div>
          )
        ) : (
          <>
            {(components > 0 || dev) && yours}
            {[...groups.entries()].map(([group, list], gi) => (
              <section key={group} className="insert-group" data-kind="section" aria-labelledby={`${id}-g${gi}`}>
                <h4 className="insert-head" id={`${id}-g${gi}`}>
                  {group}
                </h4>
                <TileGrid
                  {...(showVariants ? { bands: bandsOf(list) } : { items: list })}
                  labelledBy={`${id}-g${gi}`}
                  className={showVariants ? 'banded' : ''}
                  render={(it) => (
                    <button className={`insert-tile section${justAdded(it) ? ' just-added' : ''}`} aria-label={showVariants ? [it.name, optionLabel(it), it.defaults].filter(Boolean).join(', ') : undefined} {...tileProps(it)}>
                      <SectionThumb it={it} />
                      <span className="insert-label">
                        <strong>{showVariants ? optionLabel(it) : it.name}</strong>
                        {badge(it)}
                      </span>
                      {showVariants && it.defaults && <small className="insert-defaults">{it.defaults}</small>}
                      {description(it)}
                    </button>
                  )}
                />
              </section>
            ))}
            <section className="insert-group" data-kind="element" aria-labelledby={`${id}-basics`}>
              <h4 className="insert-head" id={`${id}-basics`}>
                Basic elements
              </h4>
              <TileGrid
                items={elements}
                labelledBy={`${id}-basics`}
                className={`compact${narrow ? ' list' : ''}`}
                cols={narrow ? 1 : 2}
                render={(it) => (
                  <button className={`insert-tile basic${justAdded(it) ? ' just-added' : ''}`} {...tileProps(it)}>
                    {iconFor(it)}
                    <strong>{it.name}</strong>
                  </button>
                )}
              />
            </section>
            {components === 0 && !dev && yours}
          </>
        )}
      </div>
      {peekItem && peek && panelRect && peekItem.kind === 'component' && st.components[peekItem.spec.definitionId!] && (
        <LibraryPeek
          it={peekItem}
          def={st.components[peekItem.spec.definitionId!]}
          st={st}
          anchor={peek.rect}
          panel={panelRect}
          map={neighboursAt(st, planOf(peekItem).at)}
          onEnter={keepPeek}
          onLeave={searching && document.activeElement === searchRef.current ? keepPeek : () => hidePeek(peek.key)}
        />
      )}
      {peekItem && peek && panelRect && peekItem.kind === 'section' && (
        <InsertPeek
          it={peekItem}
          anchor={peek.rect}
          panel={panelRect}
          option={showVariants || peekItem.variant ? `${optionLabel(peekItem)}${peekItem.defaults ? ` · ${peekItem.defaults}` : ''}` : null}
          map={neighboursAt(st, sectionAt)}
          onEnter={keepPeek}
          onLeave={searching && document.activeElement === searchRef.current ? keepPeek : () => hidePeek(peek.key)}
        />
      )}
    </div>
  );
}
