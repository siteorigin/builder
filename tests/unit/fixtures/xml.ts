/** XML checks shared by the tests of the generated sitemap and RSS feed. */

/**
 * Check a document is well-formed XML, strictly enough for what a sitemap or an RSS feed holds: one root element, every
 * tag closed in order, quoted attributes named once each, text and values with no bare "<" or "&" outside a known
 * entity, no character XML does not allow, and every namespace prefix declared on the element or one around it. Gives back the root element's name; throws with the
 * reason when the document is not well-formed.
 */
export function assertWellFormed(xml: string): string {
  // Named entities, or a character reference to anything but character zero.
  const entity = /&(?!(?:amp|lt|gt|quot|apos|#0*[1-9]\d*|#x0*[1-9a-f][0-9a-f]*);)/i;
  // Characters XML 1.0 never allows, written or as a reference: control characters other than tab and line breaks,
  // a lone half of a surrogate pair, U+FFFE and U+FFFF.
  const bad = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|&#x0*(?:[1-8bcef]|1[0-9a-f]);|&#0*(?:[1-8]|1[124-9]|2\d|3[01]);/i;
  if (bad.test(xml)) throw new Error('A character XML does not allow.');
  let rest = xml.replace(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n/, '');
  if (rest === xml) throw new Error('No XML declaration at the start.');
  const stack: Array<{ name: string; prefixes: Set<string> }> = [];
  let roots = 0;
  let root = '';
  const declared = (prefix: string) => prefix === 'xml' || stack.some((e) => e.prefixes.has(prefix));
  while (rest) {
    const lt = rest.indexOf('<');
    const text = lt < 0 ? rest : rest.slice(0, lt);
    if (entity.test(text) || text.includes('>')) throw new Error(`Bad text: ${text}`);
    if (!stack.length && text.trim()) throw new Error(`Text outside the root: ${text}`);
    if (lt < 0) break;
    // XML white space is space, tab, CR and LF only.
    const tag = rest.slice(lt).match(/^<(\/?)([A-Za-z_][\w.:-]*)((?:[ \t\r\n]+[A-Za-z_][\w.:-]*="[^"<]*")*)[ \t\r\n]*(\/?)>/);
    if (!tag) throw new Error(`Bad tag at: ${rest.slice(lt, lt + 80)}`);
    rest = rest.slice(lt + tag[0].length);
    const [, close, name, attrText, selfClose] = tag;
    if (close) {
      if (attrText || selfClose || stack.pop()?.name !== name) throw new Error(`Mismatched </${name}>`);
      continue;
    }
    const attrs = [...attrText.matchAll(/([\w.:-]+)="([^"]*)"/g)];
    const names = attrs.map((a) => a[1]);
    if (new Set(names).size !== names.length) throw new Error(`Repeated attribute on <${name}>`);
    if (attrs.some((a) => entity.test(a[2]))) throw new Error(`Bad attribute value on <${name}>`);
    const prefixes = new Set(names.filter((n) => n.startsWith('xmlns:')).map((n) => n.slice(6)));
    if (!stack.length && roots++) throw new Error('More than one root element.');
    if (!stack.length) root = name;
    stack.push({ name, prefixes });
    for (const n of [name, ...names.filter((n) => !n.startsWith('xmlns'))]) {
      const prefix = n.includes(':') ? n.split(':')[0] : null;
      if (prefix && !declared(prefix)) throw new Error(`Undeclared prefix "${prefix}" on <${name}>`);
    }
    if (selfClose) stack.pop();
  }
  if (stack.length || roots !== 1) throw new Error('The document does not close its root element.');
  return root;
}
