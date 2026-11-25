/**
 * Model text as the reader expects it: paragraphs where it left a blank line, and its lists as lists. Models are asked
 * for plain sentences, but advice often comes back as short paragraphs and a list, which should read as written rather
 * than as raw dashes. A Markdown heading, which the prompts ask models not to write, becomes a bold lead line.
 */
export type TextBlock = { kind: 'p' | 'lead' | 'ul' | 'ol'; lines: string[] };

/** A line of a bulleted or numbered list, as models write them: "- ", "* ", "• ", "1. " or "1) ". */
const LIST_ITEM = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;
const HEADING = /^\s*#{1,6}\s+/;

export function textBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const line of text.trim().split('\n')) {
    const last = blocks.at(-1);
    if (!line.trim()) {
      // A blank line ends a paragraph; a list stays one list across the blank lines some models leave between items.
      if (last?.kind === 'p') blocks.push({ kind: 'p', lines: [] });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const kind = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (last?.kind === kind) last.lines.push(line.replace(LIST_ITEM, ''));
      else blocks.push({ kind, lines: [line.replace(LIST_ITEM, '')] });
    } else if (HEADING.test(line)) blocks.push({ kind: 'lead', lines: [line.replace(HEADING, '')] });
    else if (last?.kind === 'p') last.lines.push(line);
    else blocks.push({ kind: 'p', lines: [line] });
  }
  return blocks.filter((b) => b.lines.length);
}
