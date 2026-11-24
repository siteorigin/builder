const BREAKS = /[\r\n\u2028\u2029]+/;

/**
 * Text as one line: each line break takes the spaces around it and becomes a single space (as a site name does), and
 * a break at either end of the text goes. Linear in the text, so a huge paste of spaces cannot stall the field.
 */
export function oneLine(text: string): string {
  if (!BREAKS.test(text)) return text;
  const parts = text.split(BREAKS);
  return parts
    .map((part, i) => (i === 0 ? part : part.trimStart()))
    .map((part, i, all) => (i === all.length - 1 ? part : part.trimEnd()))
    .filter((part) => part !== '')
    .join(' ');
}
