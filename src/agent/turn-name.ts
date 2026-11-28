/** Strips Markdown to the words a reader sees: link text without its target, no emphasis or code marks. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>\n]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cuts at a word boundary within `max` characters, with an ellipsis when it cut. */
export function cutAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const space = head.lastIndexOf(" ");
  const cut = space > max / 2 ? head.slice(0, space) : head;
  return `${cut.replace(/[\s,;:.\-–—]+$/, "")}…`;
}

/** The name of an AI turn in History, Undo and its toast: the first sentence of the reply as plain words. */
export function turnName(reply: string, fallback: string, max = 80): string {
  const plain = plainText(reply);
  const sentence = plain.split(/(?<=[.!?])\s/)[0] || plainText(fallback);
  return cutAtWord(sentence, max);
}
