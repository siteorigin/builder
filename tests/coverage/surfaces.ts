/**
 * The app's discoverable actions, read from the definitions that make them (issue #498): the application menu for each
 * platform, the writing menu, the command menu's commands, the sidebar's views, the editor's keyboard shortcuts, and the
 * items of every menu the editor opens (context menus, More menus, the toolbar's menus). Each is a key the coverage
 * inventory (interactions.ts) names in a route, so an action added to one of these surfaces without a row fails
 * `tests/unit/interaction-coverage.test.ts`, and a route whose action is gone fails it too.
 *
 * Keys:
 * - `menu:File > New Project…`: an application menu item that runs the app's own code, by its label path.
 * - `role:cut`: an application menu item Electron supplies (a system role).
 * - `writing:Cut`: an item of the writing menu (a right-click in text that takes typing).
 * - `command:find`, `command:page:*`: a command menu command by its id, or a family of commands made from data.
 * - `tab:pages`: a view of the left sidebar (its rail button and its command).
 * - `key:z`, `key:Escape`: a key the editor's global shortcut handler acts on, with whatever modifiers it checks.
 * - `item:Canvas:Edit text`, `item:Layers:Select *`: an item of a menu the editor draws, by the file that builds it and
 *   its label (`*` stands for the part made from data).
 *
 * The readers parse the source with TypeScript and say where a shape they do not know is, so a refactor that hides an
 * action from them fails loudly instead of quietly shrinking the list. Labels made wholly from data (a list of pages,
 * a model's choices) are left out: the row for the menu that lists them covers them.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { appMenuTemplate } from '../../src/main/app-menu.ts';
import { writingMenuTemplate } from '../../src/main/writing-menu.ts';
import type { MenuItemConstructorOptions } from 'electron';

export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const RENDERER = join(ROOT, 'src/renderer/src');

/** The kinds of key a reader makes: the surfaces whose every action must have a row. */
export const ENFORCED_PREFIXES = ['menu', 'role', 'writing', 'command', 'tab', 'key', 'item'] as const;

export const PLATFORMS = ['darwin', 'win32', 'linux'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** One discoverable action, where it is defined, and (for the application menu) the platforms that have it. */
export interface Surface {
  key: string;
  file: string;
  platforms?: Platform[];
}

// ---------------------------------------------------------------------------
// Native menus
// ---------------------------------------------------------------------------

/** The application menu's actions on each platform, with a project open (when every item is offered). */
export function nativeMenu(): Surface[] {
  const found = new Map<string, Set<Platform>>();
  const add = (key: string, p: Platform) => (found.get(key) ?? found.set(key, new Set()).get(key)!).add(p);
  const walk = (items: MenuItemConstructorOptions[], path: string[], p: Platform) => {
    for (const item of items) {
      if (item.type === 'separator') continue;
      if (item.role) add(`role:${item.role}`, p);
      else if (Array.isArray(item.submenu)) walk(item.submenu, [...path, item.label ?? '?'], p);
      else if (item.label) add(`menu:${[...path, item.label].join(' > ')}`, p);
      else throw new Error(`An application menu item with no label or role under ${path.join(' > ') || 'the menu bar'}: read it in tests/coverage/surfaces.ts.`);
    }
  };
  for (const p of PLATFORMS) walk(appMenuTemplate(p, true, { command: () => undefined, history: () => () => undefined }), [], p);
  return [...found].map(([key, ps]) => ({ key, file: 'src/main/app-menu.ts', platforms: PLATFORMS.filter((p) => ps.has(p)) }));
}

/** The writing menu's own items, for a misspelling with no suggestions in text that takes typing. */
export function writingMenu(): Surface[] {
  const none = () => undefined;
  const items = writingMenuTemplate({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: [], editFlags: {} as never }, { replaceMisspelling: none, cut: none, copy: none, paste: none, selectAll: none }) ?? [];
  const keys = items.filter((i) => i.type !== 'separator' && i.label).map((i) => `writing:${i.label}`);
  // A misspelling's suggestions are listed by the dictionary: one key stands for them.
  return ['writing:<suggestion>', ...keys].map((key) => ({ key, file: 'src/main/writing-menu.ts' }));
}

// ---------------------------------------------------------------------------
// Renderer source
// ---------------------------------------------------------------------------

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function where(sf: ts.SourceFile, n: ts.Node): string {
  return `${relative(ROOT, sf.fileName)}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
}

function visit(n: ts.Node, fn: (n: ts.Node) => void) {
  fn(n);
  ts.forEachChild(n, (c) => visit(c, fn));
}

function props(o: ts.ObjectLiteralExpression, sf: ts.SourceFile): Map<string, ts.Expression> {
  const m = new Map<string, ts.Expression>();
  for (const p of o.properties) if (ts.isPropertyAssignment(p)) m.set(p.name.getText(sf), p.initializer);
  return m;
}

/**
 * The texts a label or id expression can be: a string, each branch of a condition or a fallback, and a template with
 * `*` for each part made from data. Null for an expression made wholly from data (a variable, a property, a call).
 */
export function texts(e: ts.Expression): string[] | null {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) return texts(e.expression);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e.text];
  if (ts.isTemplateExpression(e)) return [e.head.text + e.templateSpans.map((s) => `*${s.literal.text}`).join('')];
  if (ts.isConditionalExpression(e)) {
    const a = texts(e.whenTrue);
    const b = texts(e.whenFalse);
    return a || b ? [...(a ?? []), ...(b ?? [])] : null;
  }
  if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.BarBarToken || e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    const a = texts(e.left);
    const b = texts(e.right);
    return a || b ? [...(a ?? []), ...(b ?? [])] : null;
  }
  return null;
}

/** The command menu's commands: every object with an `id` and a `run`, by id (a family for an id made from data). */
export function commands(): Surface[] {
  const sf = parse(join(RENDERER, 'panels/CommandMenu.tsx'));
  const out = new Map<string, Surface>();
  visit(sf, (n) => {
    if (!ts.isObjectLiteralExpression(n)) return;
    const p = props(n, sf);
    if (!p.has('run')) return;
    const id = p.get('id');
    if (!id) throw new Error(`A command with no id at ${where(sf, n)}: give it one, or read it in tests/coverage/surfaces.ts.`);
    // An id made wholly from data (the Insert panel's choices) is keyed by the command's fixed group: `command:Insert:*`.
    const group = p.get('group');
    const ids = texts(id) ?? (group && texts(group)?.length === 1 ? [`${texts(group)![0]}:*`] : null);
    if (!ids) throw new Error(`A command whose id is made wholly from data, with no fixed group, at ${where(sf, n)}: give it a fixed prefix (\`page:\${id}\`).`);
    for (const t of ids) out.set(`command:${t}`, { key: `command:${t}`, file: where(sf, n) });
  });
  if (out.size < 10) throw new Error(`Only ${out.size} command menu commands were found in CommandMenu.tsx: has the way commands are written changed?`);
  return [...out.values()];
}

/** The sidebar's views, from LEFT_TABS. */
export function leftTabs(): Surface[] {
  const sf = parse(join(RENDERER, 'panels/LeftTabs.tsx'));
  const out: Surface[] = [];
  visit(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || n.name.getText(sf) !== 'LEFT_TABS' || !n.initializer) return;
    let list: ts.Expression = n.initializer;
    while (ts.isAsExpression(list) || ts.isSatisfiesExpression(list)) list = list.expression;
    if (!ts.isArrayLiteralExpression(list)) throw new Error(`LEFT_TABS is not a plain list at ${where(sf, n)}.`);
    for (const el of list.elements) {
      const id = ts.isObjectLiteralExpression(el) ? props(el, sf).get('id') : undefined;
      const t = id && texts(id);
      if (!t || t.length !== 1) throw new Error(`A sidebar view with no fixed id at ${where(sf, el)}.`);
      out.push({ key: `tab:${t[0]}`, file: where(sf, el) });
    }
  });
  if (!out.length) throw new Error('No sidebar views were found in LeftTabs.tsx (LEFT_TABS).');
  return out;
}

/** The keys the editor's global shortcut handler (handleShortcut in Editor.tsx) compares against. */
export function shortcuts(): Surface[] {
  const sf = parse(join(RENDERER, 'Editor.tsx'));
  const out = new Map<string, Surface>();
  let handler = false;
  visit(sf, (n) => {
    if (!ts.isFunctionDeclaration(n) || n.name?.text !== 'handleShortcut' || !n.body) return;
    handler = true;
    visit(n.body, (c) => {
      if (!ts.isBinaryExpression(c) || c.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return;
      const left = c.left.getText(sf);
      if (left !== 'key' && left !== 'key.toLowerCase()') return;
      if (!ts.isStringLiteral(c.right)) throw new Error(`A shortcut compared with something other than a key name at ${where(sf, c)}.`);
      const k = c.right.text;
      out.set(`key:${k}`, { key: `key:${k}`, file: where(sf, c) });
    });
  });
  if (!handler) throw new Error('handleShortcut was not found in Editor.tsx: has the editor\'s shortcut handler moved?');
  return [...out.values()];
}

/** The short name a menu's items are keyed by: the file that builds it, without its extension. */
function menuOwner(file: string): string {
  return basename(file).replace(/\.(tsx|ts)$/, '').replace(/Panel$/, '');
}

/**
 * The items of every menu the editor draws (its context menus, More menus and toolbar menus): each object with a
 * `label` and an `onSelect`, keyed by the file that builds it and its label. Items labelled wholly from data are
 * counted, not keyed: the row for their menu covers them.
 */
export function menuItems(): { items: Surface[]; fromData: { file: string }[] } {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(f) && !/\.d\.ts$/.test(f)) files.push(p);
    }
  };
  walk(RENDERER);
  const items = new Map<string, Surface>();
  const fromData: { file: string }[] = [];
  for (const file of files.sort()) {
    const sf = parse(file);
    visit(sf, (n) => {
      if (!ts.isObjectLiteralExpression(n)) return;
      const p = props(n, sf);
      const label = p.get('label');
      if (!label || !p.has('onSelect')) return;
      const t = texts(label);
      if (!t) return void fromData.push({ file: where(sf, n) });
      for (const text of t) {
        const key = `item:${menuOwner(file)}:${text}`;
        if (!items.has(key)) items.set(key, { key, file: where(sf, n) });
      }
    });
  }
  if (items.size < 40) throw new Error(`Only ${items.size} menu items were found in the renderer: has the way menus are written changed?`);
  return { items: [...items.values()], fromData };
}

/** Every discoverable action the readers find. */
export function surfaces(): Surface[] {
  return [...nativeMenu(), ...writingMenu(), ...commands(), ...leftTabs(), ...shortcuts(), ...menuItems().items];
}
