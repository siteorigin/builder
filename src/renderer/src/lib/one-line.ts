/** Text as one line: every line break, with the spaces around it, becomes a single space (as a site name does). */
export const oneLine = (text: string): string => text.replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ');
