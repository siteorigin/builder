import { useMemo, useState } from 'react';
import { icons, Search, Code, CornerDownRight } from 'lucide-react';
import { catalogueEntries, CATEGORY_LABELS } from '@catalogue/index';
import { setState, useStore } from '../store';
import { insert, insertionPoint, type Primitive } from '../lib/actions';
import { refLabel } from '../lib/model';

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
          {bar('22%', 6, 'btn')}
        </span>
      );
    case 'hero.split':
      return (
        <span className="sketch split">
          <span className="col-s">
            {bar('80%', 6, 'hi')}
            {lines(2)}
            {bar('35%', 5, 'btn')}
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
          {bar('24%', 6, 'btn')}
        </span>
      );
    case 'faq.list':
      return <span className="sketch">{[...Array(4)].map((_, i) => <i key={i} className="row-line" />)}</span>;
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
      return <span className="sketch cols mid">{[...Array(5)].map((_, i) => <i key={i} style={{ height: 5 }} />)}</span>;
    case 'media.gallery':
      return <span className="sketch grid3">{[...Array(6)].map((_, i) => <i key={i} className="img" />)}</span>;
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
            {key === 'pricing' ? bar('50%', 6, 'hi') : key === 'testimonials' ? lines(2) : <i className="dot sm" />}
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
          {bar('40%', 6, 'btn')}
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

const BASICS: Array<{ id: Primitive; name: string; icon: string; tags: string }> = [
  { id: 'heading', name: 'Heading', icon: 'heading-1', tags: 'title text h1 h2' },
  { id: 'paragraph', name: 'Paragraph', icon: 'pilcrow', tags: 'text copy body' },
  { id: 'button', name: 'Button', icon: 'mouse-pointer-click', tags: 'link action cta' },
  { id: 'image', name: 'Image', icon: 'image', tags: 'photo picture' },
  { id: 'stack', name: 'Stack', icon: 'rows-3', tags: 'vertical container group' },
  { id: 'row', name: 'Row', icon: 'columns-3', tags: 'horizontal container group' },
  { id: 'grid', name: 'Grid', icon: 'layout-grid', tags: 'columns container' },
  { id: 'container', name: 'Container', icon: 'square', tags: 'box group' },
  { id: 'icon', name: 'Icon', icon: 'sparkles', tags: 'symbol' },
  { id: 'divider', name: 'Divider', icon: 'minus', tags: 'line rule separator' }
];

export function InsertPanel() {
  const snap = useStore((s) => s.snapshot);
  const selection = useStore((s) => s.selection);
  const dev = useStore((s) => !!s.settings?.developerMode);
  const [q, setQ] = useState('');
  const entries = useMemo(() => (snap ? catalogueEntries(snap.state.site.themeId) : []), [snap?.state.site.themeId]);
  if (!snap) return null;
  const st = snap.state;
  const query = q.toLowerCase().trim();
  const match = (s: string) => !query || query.split(/\s+/).every((w) => s.toLowerCase().includes(w));
  const projectDefs = Object.values(st.components).filter((d) => d.owner === 'project' && d.category !== 'shell' && match(`${d.name} ${d.description}`));
  const groups = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!match(`${e.name} ${e.description} ${e.tags.join(' ')}`)) continue;
    const list = groups.get(e.category) ?? [];
    list.push(e);
    groups.set(e.category, list);
  }
  const basics = BASICS.filter((b) => match(`${b.name} ${b.tags}`));
  const at = insertionPoint('section');
  const page = st.pages[useStore.getState().pageId ?? ''];
  const target = selection && at ? refLabel(st, { owner: selection.owner, instancePath: [], nodeId: selection.instancePath[0] ?? selection.nodeId }) : null;
  const hint = target ? (
    <>
      Sections go after <b>{target}</b>
    </>
  ) : (
    <>
      Sections go at the end of <b>{page?.title ?? 'this page'}</b>
    </>
  );
  const elAt = insertionPoint('element');
  const elTarget = elAt?.parentId && st ? refLabel(st, { owner: elAt.owner, instancePath: [], nodeId: elAt.parentId }) : null;

  return (
    <>
      <div className="panel-head">
        <h3>Insert</h3>
      </div>
      <div className="search">
        <Search />
        <input className="input" placeholder="Search sections and elements" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search sections and elements" />
      </div>
      <div className="panel-body">
        <p className="insert-hint" role="status" title={target ? 'Sections go after the selected section; basics go inside the selected container.' : 'Select a section first to add after it.'}>
          <CornerDownRight />
          <span>{hint}</span>
        </p>
        {[...groups.entries()].map(([cat, list]) => (
          <div key={cat}>
            <div className="list-section">{CATEGORY_LABELS[cat] ?? cat}</div>
            <div className="insert-grid">
              {list.map((e) => (
                <button key={e.componentId} className="insert-tile section" title={e.description} aria-describedby={undefined} onClick={() => void insert({ componentId: e.componentId }, e.name)}>
                  <SectionSketch id={e.componentId} />
                  <strong>{e.name}</strong>
                </button>
              ))}
            </div>
          </div>
        ))}
        {basics.length > 0 && (
          <>
            <div className="list-section">Basic elements</div>
            <p className="insert-hint">
              <CornerDownRight />
              <span>{elTarget ? <>These go inside <b>{elTarget}</b></> : <>These go at the end of <b>{page?.title ?? 'this page'}</b>. Select a container to add inside it.</>}</span>
            </p>
            <div className="insert-grid compact">
              {basics.map((b) => (
                <button key={b.id} className="insert-tile basic" onClick={() => void insert({ primitive: b.id }, b.name)}>
                  <span className="ico">
                    <LucideIcon name={b.icon} />
                  </span>
                  <strong>{b.name}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        <div className="list-section">
          Your components
          <span className="spacer" />
          {dev && (
            <button className="btn btn-sm btn-ghost" onClick={() => setState({ modal: { kind: 'new-code' } })}>
              <Code /> New code component
            </button>
          )}
        </div>
        {projectDefs.length ? (
          <div className="insert-grid">
            {projectDefs.map((d) => (
              <button key={d.id} className="insert-tile project" title={d.description} onClick={() => void insert({ definitionId: d.id }, d.name)}>
                <span className="ico">{d.kind === 'code' ? <Code size={15} /> : <LucideIcon name="component" />}</span>
                <strong>{d.name}</strong>
              </button>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ padding: '0 16px 16px', margin: 0, fontSize: 13 }}>
            Components you make appear here. Right-click a group of elements and choose Create component to reuse it.
          </p>
        )}
      </div>
    </>
  );
}
