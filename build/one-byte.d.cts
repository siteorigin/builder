/** Types for build/one-byte.cjs, which the build and the unit tests share. */
export interface WideCharacter {
  codePoint: string;
  line: number;
  column: number;
  context: string;
}
type Bundle = Record<string, { type: 'chunk'; code: string } | { type: 'asset'; source: string | Uint8Array }>;
export interface OneByteScriptsPlugin {
  name: string;
  apply: 'build';
  renderChunk(code: string): { code: string; map: null } | null;
  generateBundle: { order: 'post'; handler(this: { error(message: string): never }, options: unknown, bundle: Bundle): void };
}
export declare function wideCharacters(code: string, limit?: number): WideCharacter[];
export declare function escapeRawTemplates(code: string): string;
export declare function oneByteScriptsPlugin(target: 'main' | 'preload' | 'renderer'): OneByteScriptsPlugin;
