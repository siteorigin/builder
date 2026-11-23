import { useMemo, useState } from 'react';
import { icons, Search, Code } from 'lucide-react';
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
  const hint = selection && at ? `Sections are added after ${refLabel(st, { owner: selection.owner, instancePath: [], nodeId: selection.instancePath[0] ?? selection.nodeId })}. Basics go inside the selected container.` : 'Sections are added at the end of the page. Select a section first to insert after it.';

  return (
    <>
      <div className="panel-head">
        <h3>Insert</h3>
      </div>
      <div className="search">
        <Search />
        <input className="input" placeholder="Search components" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search components" />
      </div>
      <div className="panel-body">
        <p className="insert-hint">{hint}</p>
        {basics.length > 0 && (
          <>
            <div className="list-section">Basics</div>
            <div className="insert-grid">
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
        {[...groups.entries()].map(([cat, list]) => (
          <div key={cat}>
            <div className="list-section">
              {CATEGORY_LABELS[cat] ?? cat}
              <span className="spacer" />
              <span className="badge">Theme</span>
            </div>
            <div className="insert-grid">
              {list.map((e) => (
                <button key={e.componentId} className="insert-tile" title={e.description} onClick={() => void insert({ componentId: e.componentId }, e.name)}>
                  <span className="ico">
                    <LucideIcon name={e.icon} />
                  </span>
                  <strong>{e.name}</strong>
                </button>
              ))}
            </div>
          </div>
        ))}
        <div className="list-section">
          Project components
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
          <p className="faint" style={{ padding: '0 16px 16px', margin: 0, fontSize: 12 }}>
            Select a group of elements and choose <em>Create component</em> to reuse it here.
          </p>
        )}
      </div>
    </>
  );
}
