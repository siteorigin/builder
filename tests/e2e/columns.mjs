// Column layouts (#514). Insert offers 2 and 3 columns near its top: one click adds a Grid holding that many empty
// columns, each framed on the canvas, as one change with the first column selected, so the next element fills it. A
// plain click on another column selects it and Insert fills that, one change per insert, each its own Undo; one more
// Undo takes the layout away with the Section made for it. A Section placement arranges its own columns from the
// Inspector without Parts: Column layout turns its Container into a narrow-and-wide grid with separate row and column
// gaps, on that Section alone. The uneven starters (#665) work the same way: a Bento grid of a two-wide featured tile
// and a two-tall tile, a main column beside a sidebar pinned below the site header, and a wide-and-narrow split, each
// laid out on desktop and stacked on phones.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { MOD, createProject, eventually, launch, scratch, step } from './harness.mjs';

const { WORK, SHOTS: OUT, cleanup } = scratch('columns');
const { app, win, errors } = await launch(WORK);
const frame = await createProject(win, { name: 'Column Studio', parentDir: join(WORK, 'sites'), starter: 'blank', sampleImages: false });

const snapshot = () => win.evaluate(async () => (await window.builder.project.snapshot()).state);
const page = async () => {
  const s = await snapshot();
  return s.pages[s.site.homePageId];
};
const owner = async () => ({ kind: 'page', id: (await snapshot()).site.homePageId });
/** Changes History holds, applied (it trims old ones by size, which none of these reach). */
const applied = () => win.evaluate(async () => (await window.builder.project.snapshot()).history.entries.filter((e) => e.applied).length);
/** The chip on the canvas names what is selected ("Columns actions"); none shows with nothing selected. */
const chip = () => win.locator('.ov-chip:not(.editing)');
const selected = async () => ((await chip().count()) ? await chip().first().getAttribute('aria-label') : null);
const panel = win.locator('.side-panel-view:not([hidden])');
const openInsert = async () => {
  if ((await panel.locator('.insert-group[data-group="basics"]').count()) === 0) await win.locator('.rail [aria-label="Insert"]').click();
  await panel.locator('.insert-group[data-group="basics"]').waitFor();
};
const tile = (label) => panel.locator('.insert-tile.basic', { has: win.locator('strong', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
const at = (id) => frame.locator(`[data-so-node="${id}"]`).first();
/** The element's box in the page, and whether the canvas frames it as an empty container. */
const boxOf = (id) =>
  at(id).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, framed: el.getAttribute('data-so-empty-layout') };
  });
/** A plain click on the middle of an element in the page, scaled from the zoomed-out canvas to the window. */
const clickMiddle = async (locator) => {
  const p = await locator.evaluate((el) => {
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: innerWidth };
  });
  const box = await win.locator('.frame-box iframe').boundingBox();
  const scale = box.width / p.width;
  await win.mouse.click(box.x + p.x * scale, box.y + p.y * scale);
};
const undo = async () => {
  await win.locator('.canvas').hover({ position: { x: 4, y: 4 } }).catch(() => undefined);
  await win.keyboard.press(`${MOD}+z`);
};

try {
  step('Insert offers the column layouts above the theme’s sections, beside the Row and the Grid');
  await openInsert();
  const groups = await panel.locator('.insert-group').evaluateAll((els) => els.map((g) => g.dataset.group ?? g.dataset.kind));
  assert.ok(groups.indexOf('columns') >= 0 && groups.indexOf('columns') < groups.indexOf('section'), `the column layouts come before the sections: ${groups}`);
  const columnTiles = await panel.locator('.insert-group[data-group="columns"] .insert-tile strong').allInnerTexts();
  assert.deepEqual(columnTiles, ['2 columns', '3 columns', 'Bento grid', 'Sidebar + main', 'Asymmetric split', 'Row', 'Grid']);
  await panel.locator('.insert-group[data-group="columns"]').screenshot({ path: join(OUT, 'column-layouts.png') });

  step('2 columns: one change adds a Grid with two empty, framed columns side by side, the first selected to fill');
  const before = await applied();
  const rootsBefore = (await page()).rootIds.length;
  await tile('2 columns').click();
  const { gridId, columns, sectionId } = await eventually(async () => {
    const p = await page();
    const grid = Object.values(p.nodes).find((n) => n.kind === 'element' && n.name === 'Columns');
    assert.ok(grid, 'the Grid is on the page');
    assert.equal(grid.children.length, 2, 'with two columns');
    const section = Object.values(p.nodes).find((n) => n.kind === 'instance' && n.slots?.content?.includes(grid.id));
    assert.ok(section, 'in a new Section');
    return { gridId: grid.id, columns: grid.children, sectionId: section.id };
  }, 30000);
  // History is installed just after the change itself, so the count is read once it has caught up.
  await eventually(async () => assert.equal(await applied(), before + 1, 'one change'), 15000);
  await eventually(async () => assert.equal(await selected(), 'Column 1 actions', 'the first column is selected, ready to fill'), 15000);
  const [left, right] = columns;
  await eventually(async () => {
    const [l, r] = [await boxOf(left), await boxOf(right)];
    assert.deepEqual([l.framed, r.framed], ['Stack', 'Stack'], 'each empty column is framed');
    assert.ok(l.height >= 72 && r.height >= 72, `each is tall enough to pick: ${JSON.stringify([l, r])}`);
    assert.ok(Math.abs(l.y - r.y) < 2 && l.x + l.width <= r.x, `side by side: ${JSON.stringify([l, r])}`);
    // Two tracks on desktop, not the three a plain Grid starts with.
    assert.equal(await at(gridId).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length), 2);
  }, 30000);
  await win.screenshot({ path: join(OUT, 'two-columns.png') });

  step('Insert fills the selected first column; a plain click on the second selects it, and Insert fills that: one change, and one Undo, each');
  const fill = async (column, label, tag, click) => {
    if (click) await clickMiddle(at(column));
    const name = (await page()).nodes[column].name;
    await eventually(async () => assert.equal(await selected(), `${name} actions`, `${name} is selected`), 10000);
    const n = await applied();
    await tile(label).click();
    const child = await eventually(async () => {
      const p = await page();
      assert.equal(p.nodes[column].children.length, 1, `${label} lands in ${name}`);
      const c = p.nodes[p.nodes[column].children[0]];
      assert.deepEqual([c.kind, c.tag], ['text', tag]);
      return c.id;
    }, 30000);
    await eventually(async () => assert.equal(await applied(), n + 1, 'one change'), 15000);
    await eventually(async () => assert.equal(await at(column).evaluate((el, id) => !!el.querySelector(`[data-so-node="${id}"]`), child), true, `${label} shows inside ${name}`), 30000);
    return child;
  };
  await openInsert();
  await fill(left, 'Heading', 'h2', false);
  await fill(right, 'Paragraph', 'p', true);
  assert.deepEqual((await page()).nodes[gridId].children, columns, 'the Grid still holds just its two columns');
  await eventually(async () => assert.deepEqual([(await boxOf(left)).framed, (await boxOf(right)).framed], [null, null], 'filled columns lose their frames'), 30000);
  await win.screenshot({ path: join(OUT, 'two-columns-filled.png') });

  await undo();
  await eventually(async () => {
    const p = await page();
    assert.deepEqual([p.nodes[left].children.length, p.nodes[right].children.length], [1, 0], 'the first Undo empties the right column alone');
  }, 15000);
  await eventually(async () => assert.equal((await boxOf(right)).framed, 'Stack', 'and it is framed again'), 30000);
  await undo();
  await eventually(async () => assert.equal((await page()).nodes[left].children.length, 0, 'the second empties the left'), 15000);
  await undo();
  await eventually(async () => {
    const p = await page();
    assert.equal(p.nodes[gridId], undefined, 'the third takes the layout away');
    assert.equal(p.nodes[sectionId], undefined, 'with the Section made for it');
    assert.equal(p.rootIds.length, rootsBefore);
  }, 15000);
  await eventually(async () => assert.equal(await applied(), before, 'History is back where it started'), 15000);

  /** Each cell's box, by name. */
  const boxes = async (cells) => {
    const p = await page();
    return Object.fromEntries(await Promise.all(cells.map(async (id) => [p.nodes[id].name, await boxOf(id)])));
  };
  const near = (a, b, what, slack = 3) => assert.ok(Math.abs(a - b) <= slack, `${what}: ${a} against ${b}`);
  /** Shows the page at a size, once the canvas is that wide: under 768px for Phone, 1024px and up for Desktop. */
  const showAt = async (size) => {
    await win.getByRole('button', { name: size, exact: true }).first().click();
    await eventually(async () => {
      const width = await frame.locator('body').evaluate(() => innerWidth);
      assert.ok(size === 'Phone' ? width < 768 : width >= 1024, `the canvas shows ${size}: ${width}px`);
    }, 15000);
  };
  const STARTERS = [
    {
      tile: 'Bento grid',
      cells: ['Featured tile', 'Tall tile', 'Tile 3', 'Tile 4'],
      // Three columns: the featured tile two wide, the tall tile two high beside it, two tiles under the featured one.
      desktop: (b, tracks) => {
        assert.equal(tracks.length, 3, `three columns: ${tracks}`);
        const { 'Featured tile': f, 'Tall tile': t, 'Tile 3': c, 'Tile 4': d } = b;
        near(f.y, t.y, 'the featured and tall tiles share the top row');
        near(f.width, c.width + d.width + (d.x - c.x - c.width), 'the featured tile spans the two columns under it');
        near(f.x, c.x, 'the featured tile starts where Tile 3 does');
        assert.ok(t.x >= f.x + f.width, 'the tall tile is beside the featured one');
        near(c.y, d.y, 'Tiles 3 and 4 share the second row');
        assert.ok(c.y >= f.y + f.height, 'under the featured tile');
        near(t.y + t.height, c.y + c.height, 'the tall tile runs down both rows');
      }
    },
    {
      tile: 'Sidebar + main',
      cells: ['Main', 'Sidebar'],
      desktop: (b, tracks) => {
        assert.equal(tracks.length, 2, `two columns: ${tracks}`);
        assert.ok(Math.abs(tracks[0] / tracks[1] - 2) < 0.05, `the main column is twice the sidebar: ${tracks}`);
        near(b.Main.y, b.Sidebar.y, 'side by side');
        assert.ok(b.Main.x + b.Main.width <= b.Sidebar.x, 'the sidebar on the right');
      }
    },
    {
      tile: 'Asymmetric split',
      cells: ['Wide column', 'Narrow column'],
      desktop: (b, tracks) => {
        assert.equal(tracks.length, 2, `two columns: ${tracks}`);
        assert.ok(Math.abs(tracks[0] / tracks[1] - 2) < 0.05, `the wide column is twice the narrow one: ${tracks}`);
        near(b['Wide column'].y, b['Narrow column'].y, 'side by side');
      }
    }
  ];
  for (const starter of STARTERS) {
    step(`${starter.tile}: one change adds its empty, framed cells laid out on desktop, the first selected to fill`);
    await win.keyboard.press('Escape');
    await openInsert();
    const n = await applied();
    const roots = (await page()).rootIds.length;
    await tile(starter.tile).click();
    const { gridId: grid, cells, sectionId: section } = await eventually(async () => {
      const p = await page();
      const g = Object.values(p.nodes).find((x) => x.kind === 'element' && x.name === starter.tile);
      assert.ok(g, `the ${starter.tile} is on the page`);
      assert.deepEqual(g.children.map((id) => p.nodes[id].name), starter.cells);
      const s = Object.values(p.nodes).find((x) => x.kind === 'instance' && x.slots?.content?.includes(g.id));
      assert.ok(s, 'in a new Section');
      return { gridId: g.id, cells: g.children, sectionId: s.id };
    }, 30000);
    await eventually(async () => assert.equal(await applied(), n + 1, 'one change'), 15000);
    await eventually(async () => assert.equal(await selected(), `${starter.cells[0]} actions`, 'the first cell is selected, ready to fill'), 15000);
    await eventually(async () => {
      const b = await boxes(cells);
      for (const [name, box] of Object.entries(b)) {
        assert.equal(box.framed, 'Stack', `${name} is framed`);
        assert.ok(box.height >= 72, `${name} is tall enough to pick: ${JSON.stringify(box)}`);
      }
      starter.desktop(b, await at(grid).evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').map(parseFloat)));
    }, 30000);
    await win.screenshot({ path: join(OUT, `${starter.tile.replace(/\W+/g, '-').toLowerCase()}.png`) });

    step(`${starter.tile}: Insert fills the selected cell, and a plain click picks the next to fill`);
    await openInsert();
    await fill(cells[0], 'Heading', 'h2', false);
    await fill(cells[1], 'Paragraph', 'p', true);
    await eventually(async () => {
      const b = await boxes(cells);
      assert.deepEqual(Object.values(b).map((x) => x.framed), starter.cells.map((_, i) => (i < 2 ? null : 'Stack')), 'filled cells lose their frames, the empty ones keep theirs');
    }, 30000);

    step(`${starter.tile}: one column on phones, the cells one above the other in order`);
    await showAt('Phone');
    await eventually(async () => {
      assert.deepEqual(await at(grid).evaluate((el) => [getComputedStyle(el).display, getComputedStyle(el).gridTemplateColumns.split(' ').length]), ['grid', 1], 'one column');
      const list = Object.values(await boxes(cells));
      for (let i = 1; i < list.length; i++) {
        near(list[i].x, list[0].x, 'stacked at the same edge', 2);
        assert.ok(list[i].y >= list[i - 1].y + list[i - 1].height, `each below the last: ${JSON.stringify(list)}`);
      }
      if (starter.tile === 'Sidebar + main') assert.equal(await at(cells[1]).evaluate((el) => getComputedStyle(el).position), 'static', 'the sidebar scrolls with the page on phones');
    }, 30000);
    await win.screenshot({ path: join(OUT, `${starter.tile.replace(/\W+/g, '-').toLowerCase()}-phone.png`) });
    await showAt('Desktop');

    let changes = 2;
    if (starter.tile === 'Sidebar + main') {
      step('Sidebar + main: the sidebar stays pinned below the site header while a long main column scrolls past');
      const tall = await win.evaluate(
        async ({ host, main }) => (await window.builder.project.apply({ operations: [{ type: 'node.setStyle', owner: host, nodeId: main, scope: 'base', property: 'minHeight', value: '2400px' }] }, { label: 'Long main column' })).ok,
        { host: await owner(), main: cells[0] }
      );
      assert.ok(tall);
      changes++;
      /** The sidebar and main column with the page scrolled `travel` pixels past the grid's top, instantly. */
      const scrolled = (travel) =>
        at(cells[1]).evaluate((el, travel) => {
          const grid = el.parentElement;
          const main = el.previousElementSibling;
          scrollTo({ top: grid.getBoundingClientRect().top + scrollY + travel, behavior: 'instant' });
          const css = getComputedStyle(el);
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
          const header = parseFloat(css.getPropertyValue('--so-header-offset'));
          return {
            position: css.position,
            // Below the header's published offset (4.5rem when none is), and 1.5rem more.
            expected: (Number.isNaN(header) ? 4.5 * rem : header) + 1.5 * rem,
            sidebar: el.getBoundingClientRect().top,
            main: main.getBoundingClientRect().top,
            mainHeight: main.getBoundingClientRect().height
          };
        }, travel);
      await eventually(async () => {
        for (const travel of [900, 1500]) {
          const p = await scrolled(travel);
          assert.equal(p.position, 'sticky', JSON.stringify(p));
          assert.ok(p.mainHeight >= 2400, `the main column is long: ${JSON.stringify(p)}`);
          assert.ok(p.main < 0, `the main column has scrolled up past the top: ${JSON.stringify(p)}`);
          near(p.sidebar, p.expected, `${travel}px down, the sidebar is held below the header`, 2);
        }
      }, 30000);
      await win.screenshot({ path: join(OUT, 'sidebar-pinned.png') });
    }

    step(`${starter.tile}: each change has its own Undo, and one more takes the layout away with its Section`);
    for (let i = 0; i < changes; i++) {
      const before = await applied();
      await undo();
      await eventually(async () => assert.equal(await applied(), before - 1, `Undo ${i + 1} steps back one change`), 15000);
    }
    await eventually(async () => {
      const p = await page();
      assert.deepEqual(cells.map((id) => p.nodes[id].children.length), starter.cells.map(() => 0), 'the cells are empty again');
    }, 15000);
    await undo();
    await eventually(async () => {
      const p = await page();
      assert.equal(p.nodes[grid], undefined, `one Undo takes the ${starter.tile} away`);
      assert.equal(p.nodes[section], undefined, 'with the Section made for it');
      assert.equal(p.rootIds.length, roots);
    }, 15000);
    await eventually(async () => assert.equal(await applied(), n, 'History is back where it started'), 15000);
  }

  step('a Section placement arranges its columns from the Inspector, without Parts');
  const host = await owner();
  const made = await win.evaluate(async (host) => {
    const r = await window.builder.project.apply(
      {
        operations: [
          { type: 'node.insert', owner: host, parentId: null, componentId: 'layout.section' },
          { type: 'node.insert', owner: host, parentId: null, componentId: 'layout.section' }
        ]
      },
      { label: 'Add two sections' }
    );
    if (!r.ok) throw new Error(r.error?.message);
    const [one, two] = r.results.map((x) => x.nodeId);
    const fill = await window.builder.project.apply(
      {
        operations: [one, one, two].map((id, i) => ({ type: 'node.insert', owner: host, parentId: id, slot: 'content', primitive: 'paragraph', text: ['Narrow side', 'Wide side', 'Other section'][i] }))
      },
      { label: 'Fill them' }
    );
    if (!fill.ok) throw new Error(fill.error?.message);
    return { one, two, first: fill.results[0].nodeId };
  }, host);
  await eventually(async () => assert.equal(await at(made.first).count(), 1, 'the sections show'), 30000);
  await win.keyboard.press('Escape');
  await clickMiddle(at(made.first));
  await eventually(async () => assert.equal(await selected(), 'Section actions', 'the first click selects the Section'), 10000);
  const inspector = win.locator('#dock-panel-inspect');
  const columnLayout = inspector.locator('.section', { has: win.locator('.section-head', { hasText: /Column layout/ }) });
  await columnLayout.waitFor();
  const row = (prop) => columnLayout.locator(`.style-row[data-prop="${prop}"]`);
  // Only what arranges columns: the Container's width and text alignment stay with its own styles.
  assert.equal(await columnLayout.locator('.style-row[data-prop="maxWidth"], .style-row[data-prop="textAlign"]').count(), 0);
  await row('layout').locator('select').selectOption('grid');
  await row('gridTemplate').waitFor();
  await row('gridTemplate').locator('select').first().selectOption('1fr 2fr');
  await row('rowGap').locator('select').first().selectOption('token:space.xl');
  await row('columnGap').locator('select').first().selectOption('token:space.sm');
  const inner = frame.locator(`.so-o-${made.one}-container`);
  await eventually(async () => {
    const css = await inner.evaluate((el) => {
      const s = getComputedStyle(el);
      return { display: s.display, tracks: s.gridTemplateColumns.split(' ').map(parseFloat), rowGap: parseFloat(s.rowGap), columnGap: parseFloat(s.columnGap) };
    });
    assert.equal(css.display, 'grid', JSON.stringify(css));
    assert.equal(css.tracks.length, 2, JSON.stringify(css));
    assert.ok(Math.abs(css.tracks[1] / css.tracks[0] - 2) < 0.1, `the second column is twice the first: ${JSON.stringify(css)}`);
    assert.ok(css.rowGap > css.columnGap && css.columnGap > 0, `separate gaps: ${JSON.stringify(css)}`);
  }, 30000);
  await eventually(async () => {
    const p = await page();
    assert.deepEqual(p.nodes[made.one].overrides?.container?.base, { layout: 'grid', gridTemplate: '1fr 2fr', rowGap: { token: 'space.xl' }, columnGap: { token: 'space.sm' } });
    assert.equal(p.nodes[made.two].overrides, undefined, 'the other Section keeps its own layout');
  }, 15000);
  await eventually(async () => assert.match(await columnLayout.locator('.section-head').innerText(), /(^|\D)4 changes/), 15000);
  await columnLayout.screenshot({ path: join(OUT, 'section-column-layout.png') });

  assert.deepEqual(errors, [], 'no page errors');
} finally {
  await app.close();
}
// Only once the app has closed: it writes to its folder until then. A failed run keeps it for inspection.
cleanup();
console.log('\ncolumns: all checks passed');
