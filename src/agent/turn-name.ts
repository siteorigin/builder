/** Strips Markdown to the words a reader sees: link text without its target, no emphasis or code marks. */
export function plainText(markdown: string): string {
  const code: string[] = [];
  // Code spans keep their characters as written, so they are set aside before anything else is read.
  const keep = (s: string) => `\u0000${code.push(s) - 1}\u0000`;
  const out = markdown
    .replace(/(```|~~~)[\s\S]*?\1/g, ' ')
    .replace(/`([^`]*)`/g, (_m, s: string) => keep(s))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, s: string) => keep(s))
    .replace(/(?<![(\[])\bhttps?:\/\/[^\s)<>\]]+/g, (m) => keep(m))
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
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
  // The sentence is found in the Markdown, where a link's text and target hold no sentence breaks.
  const first = (text: string) => plainText(text.trim().split(/(?<=[.!?]["'”’)]?)\s/)[0] ?? '');
  return cutAtWord(first(reply) || first(fallback) || 'Changes', max);
}
