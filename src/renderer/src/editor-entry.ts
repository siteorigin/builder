/**
 * The editor: its screen, the canvas, the panels and what they bring (the code editor, the engine, the generator).
 * Loaded on demand (lib/editor-module.ts), so a launch to Welcome never evaluates it.
 */
export { Editor, handleShortcut } from './Editor';
export { frameTextFocus, inlineEdit, stepVisitor } from './panels/Canvas';
export { cancelComponentPreviews, runComponentPreviews, runInspection } from './lib/inspect';
export { forgetCopy } from './lib/clipboard';
export { runPreviewControl } from './lib/preview-control';
