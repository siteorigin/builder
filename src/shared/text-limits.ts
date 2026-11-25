/**
 * The most characters the project keeps for page details and image descriptions. The operation schemas, the
 * engine and the editor's fields all read this one table, so a field shows its limit while the author types,
 * and text over it is refused whole, with a message, wherever it comes from: never cut short.
 */
export const TEXT_LIMITS = {
  pageTitle: 80,
  navLabel: 40,
  seoTitle: 120,
  pageDescription: 320,
  byline: 80,
  excerpt: 320,
  siteDescription: 320,
  /** A placed image's description (its alt text). */
  imageAlt: 300,
  /** A library image's suggested description, which a newly placed copy starts from. */
  altSuggestion: 300,
  /** A library file's own notes. */
  assetDescription: 500,
  /** The project brief's description (#518): what the site is and who it is for, in a line or two. */
  projectDescription: 320,
  /** The project brief's working notes. */
  projectNotes: 20000
} as const;

/** Why text over a limit was refused: its length and the limit, for the author and for a model to repair from. */
export function tooLongMessage(length: number, limit: number): string {
  return `${length} characters is longer than the ${limit} allowed.`;
}
