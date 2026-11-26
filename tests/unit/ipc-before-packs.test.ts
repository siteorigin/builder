/**
 * The editor's requests that the main process answers while the theme packs are still being verified (src/main/index.ts
 * `handle(..., { anytime: true })`). Everything else waits for verification, since nothing may reach a pack before it is
 * verified. Welcome's own requests are among those that do not wait (#958): it shows, with its recent projects, while
 * the packs are verified, and none of them reaches a pack.
 */
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const FILE = 'src/main/index.ts';
const source = ts.createSourceFile(FILE, readFileSync(FILE, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

/** Every channel registered with `handle`, and whether it answers before the packs are verified. */
function channels(): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'handle' && node.arguments.length >= 2 && ts.isStringLiteral(node.arguments[0])) {
      const opts = node.arguments[2];
      const anytime = !!opts && ts.isObjectLiteralExpression(opts) && opts.properties.some((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === 'anytime' && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
      out.set(node.arguments[0].text, anytime);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

describe('requests answered before the theme packs are verified', () => {
  it('are exactly the failure screens’ and Welcome’s, none of which reaches a pack', () => {
    const all = channels();
    expect(all.size).toBeGreaterThan(50);
    expect([...all].filter(([, anytime]) => anytime).map(([c]) => c).sort()).toEqual(['app:buildDetails', 'app:info', 'app:openExternal', 'app:quit', 'project:snapshot', 'projects:recents']);
    // What reaches a pack, or opens a project that does, still waits.
    for (const channel of ['app:catalogue', 'packs:preview', 'projects:open', 'projects:create', 'projects:trustAndOpen']) expect(all.get(channel)).toBe(false);
  });

  it('keeps the editor’s compiled script between launches', () => {
    expect(source.text).toMatch(/registerSchemesAsPrivileged\(\[\{ scheme: 'app', privileges: \{[^}]*\bcodeCache: true\b[^}]*\} \}\]\)/);
  });
});
