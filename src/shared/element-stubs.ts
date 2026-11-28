/**
 * The words a basic element is inserted with (engine/apply.ts, primitiveNode), so a new heading or paragraph shows on
 * the canvas before anything is written in it. Project health names one the published site still shows
 * (engine/sample-content.ts), until it is written over or kept as it is.
 */
export const ELEMENT_STUBS = {
  heading: 'New heading',
  /** A paragraph's words, and a rich text block's one paragraph. */
  paragraph: 'Write something here.',
  /** A badge's label. */
  badge: 'New',
  /** A figure's caption. */
  caption: 'Add a caption.',
  button: 'Button'
} as const;
