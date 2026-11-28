const STOPS: Record<string, string> = { '.': '\u0001', '!': '\u0002', '?': '\u0003' };

/** Strips Markdown to the words a reader sees: link text without its target, no emphasis or code marks. */
export function plainText(markdown: string, maskLinkStops = false): string {
  // A sentence stop inside link text ("Acme Inc.") is not the end of the sentence, so it can be masked for the splitter.
  const mask = (t: string) => (maskLinkStops ? t.replace(/[.!?]/g, (c) => STOPS[c]) : t);
  const code: string[] = [];
  // Code spans keep their characters as written, so they are set aside before anything else is read.
  const keep = (s: string) => `\u0000${code.push(s) - 1}\u0000`;
  const out = markdown
    .replace(/(```|~~~)[\s\S]*?\1/g, ' ')
    .replace(/`([^`]*)`/g, (_m, s: string) => keep(s))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, s: string) => keep(s))
    .replace(/(?<![(\[])\bhttps?:\/\/[^\s)<>\]*"'`]+/g, (m) => keep(m))
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+(?:"[^"]*"|'[^']*'))?\)/g, (_m, t: string) => mask(t))
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, (_m, t: string) => mask(t))
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, ' ')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1$2');
  return out
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)])
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cuts at a word boundary within `max` characters, with an ellipsis when it cut. */
export function cutAtWord(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  const cut = space > 0 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/** The name of an AI turn in History, Undo and its toast: the first sentence of the reply as plain words. */
export function turnName(reply: string, fallback: string, max = 80): string {
  const first = (text: string) => {
    const sentence = plainText(text, true).split(/(?<=[.!?]["'”’)]?)\s/)[0] ?? '';
    return sentence.replace(/[\u0001-\u0003]/g, (c) => ['.', '!', '?'][c.charCodeAt(0) - 1]).trim();
  };
  return cutAtWord(first(reply) || first(fallback) || 'Changes', max);
}
