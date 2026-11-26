// Text as the sidebar lists' find fields compare it (Pages, Posts): one comparison for finding and for marking.

/**
 * Text folded for finding (lower-case, accents dropped, however they are typed), with the index in the original
 * text of each folded character, so a match maps back onto what is shown.
 */
export function folded(s: string): { text: string; at: number[] } {
  let text = '';
  const at: number[] = [];
  [...s].forEach((c, i) => {
    // One index per UTF-16 unit, as indexOf counts them, so a match after an emoji maps back onto the right letters.
    // A final sigma is a sigma: lowered a character at a time, "Σ" is "σ" wherever it stands, so "φως" finds "ΦΩΣ".
    for (const f of c.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/ς/g, 'σ')) for (let k = 0; k < f.length; k++) (text += f[k]), at.push(i);
  });
  return { text, at };
}
export const fold = (s: string) => folded(s).text;
