// Editing flows against the real app: inline text, insert, responsive override, undo, export.
import { _electron as electron } from 'playwright';
import { mkdirSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.env.SHOTS;
const WORK = process.env.WORK;
rmSync(WORK, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });
const step = (m) => console.log(`\n== ${m}`);
const app = await electron.launch({ args: ['.'], env: { ...process.env, SITEORIGIN_USER_DATA: join(WORK, 'userdata'), OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '' } });
const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => m.type() !== 'debug' && logs.push(`[${m.type()}] ${m.text()}`));
await win.setViewportSize({ width: 1440, height: 900 });
await win.waitForSelector('.welcome');
const res = await win.evaluate((dir) => window.builder.projects.create({ name: 'Harbour Lane Studio', parentDir: dir, starter: 'business', sampleImages: true }), join(WORK, 'sites'));
console.log('create', res);
const dir = join(WORK, 'sites', 'harbour-lane-studio');
const frame = win.frameLocator('.frame-box iframe');
await frame.locator('h1').first().waitFor({ timeout: 60000 });
await win.waitForTimeout(1500);
await win.screenshot({ path: join(OUT, '10-images.png') });

step('inline text edit');
const h1 = frame.locator('h1').first();
await h1.click();
await win.waitForTimeout(300);
await h1.dblclick();
await win.waitForTimeout(300);
await win.keyboard.type('Rooms that work beautifully');
await win.keyboard.press('Enter');
await win.waitForTimeout(1500);
const homeSrc = readFileSync(join(dir, 'src/routes/+page.svelte'), 'utf8');
console.log('heading in source:', homeSrc.includes('Rooms that work beautifully'), '| instrumentation in source:', homeSrc.includes('data-so-'));
console.log('preview h1:', await h1.innerText());

step('insert pricing via Insert panel');
await win.getByRole('button', { name: 'Insert', exact: true }).click();
await win.getByRole('button', { name: 'Pricing' }).click();
await win.waitForTimeout(1500);
console.log('pricing sections:', await frame.locator('text=Clear packages, no surprises').count());
await win.screenshot({ path: join(OUT, '11-inserted.png') });

step('phone-only padding override on selected section');
await win.getByRole('button', { name: 'Phone', exact: true }).first().click();
await win.waitForTimeout(800);
await win.getByRole('button', { name: 'Style', exact: true }).last().click();
await win.getByRole('group', { name: 'Style scope' }).getByRole('button', { name: 'Phone', exact: true }).click();
const row = win.locator('.style-row', { hasText: 'Vertical padding' }).first();
await row.locator('select').selectOption({ label: 'Large · 24px' }).catch(async () => { await row.locator('select').selectOption('token:space.lg'); });
await win.waitForTimeout(1500);
const css = readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8');
console.log('phone media rule present:', /@media \(max-width: 767\.98px\)[\s\S]*padding-block: var\(--so-space-lg\)/.test(css));
await win.screenshot({ path: join(OUT, '12-phone.png') });

step('undo / redo');
await win.locator('[aria-label^="Undo"]').first().click();
await win.waitForTimeout(1000);
console.log('after undo phone rule present:', /padding-block: var\(--so-space-lg\)/.test(readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8')));
await win.locator('[aria-label^="Redo"]').first().click();
await win.waitForTimeout(1000);
console.log('after redo phone rule present:', /padding-block: var\(--so-space-lg\)/.test(readFileSync(join(dir, 'src/lib/siteorigin/styles/site.css'), 'utf8')));

step('drag to reorder: canvas grip and layers');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await win.waitForTimeout(800);
const order = async () => win.evaluate(async () => { const s = await window.builder.project.snapshot(); const p = s.state.pages[s.state.site.homePageId]; return p.rootIds.map((id) => s.state.components[p.nodes[id].definitionId]?.name); });
console.log('before:', (await order()).slice(0, 3).join(', '));
await win.locator('.rail [aria-label="Layers"]').click();
await win.locator('.list-item', { hasText: 'Split hero' }).click();
await win.waitForTimeout(800);
const grip = win.locator('.ov-chip [aria-label="Drag to move"]');
const gb = await grip.boundingBox();
const wrap = await win.locator('.frame-wrap').boundingBox();
await win.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
await win.mouse.down();
await win.mouse.move(wrap.x + wrap.width / 2, wrap.y + 620, { steps: 8 });
await win.waitForTimeout(200);
await win.screenshot({ path: join(OUT, '16-drag.png') });
await win.mouse.up();
await win.waitForTimeout(1200);
console.log('after canvas drag:', (await order()).slice(0, 3).join(', '));
await win.locator('.list-item', { hasText: 'Split hero' }).dragTo(win.locator('.list-item', { hasText: 'Logo strip' }), { targetPosition: { x: 40, y: 4 } });
await win.waitForTimeout(1200);
console.log('after layers drag:', (await order()).slice(0, 3).join(', '));

step('desktop + site styles + chat panel');
await win.getByRole('button', { name: 'Desktop', exact: true }).first().click();
await win.locator('.dock-tab', { hasText: 'Styles' }).click();
await win.waitForTimeout(500);
await win.screenshot({ path: join(OUT, '13-styles.png') });
await win.locator('.dock-tab', { hasText: 'AI' }).click();
await win.waitForTimeout(500);
await win.screenshot({ path: join(OUT, '14-chat.png') });
await win.locator('.rail [aria-label="Layers"]').click();
await win.waitForTimeout(300);
await win.screenshot({ path: join(OUT, '15-layers.png') });

step('export static');
const t0 = Date.now();
const exportDir = join(WORK, 'export-static');
const er = await win.evaluate((dest) => window.builderTest.exportStatic(dest), exportDir);
if (er.ok) {
  const html = readFileSync(join(exportDir, 'about/index.html'), 'utf8');
  console.log('about prerendered with content:', html.includes('A small studio with a long view'), '| no editor markup:', !/data-so-|siteorigin-bridge/.test(html));
  console.log('export files:', readdirSync(exportDir).join(', '));
}
console.log('export result', er, Date.now() - t0, 'ms');
console.log(logs.filter((l) => !l.includes('[vite]')).slice(-20).join('\n'));
await app.close();
