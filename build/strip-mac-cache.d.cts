/** Types for build/strip-mac-cache.cjs, which the packaging hook and the unit tests share. */
export function macOnlyPackages(lock: { packages?: Record<string, { os?: string[]; integrity?: string }> }): { location: string; integrity?: string }[];
export function contentFiles(cache: string, integrity: string): string[];
export function stripMacOnly(cache: string, lockFile: string): string[];
