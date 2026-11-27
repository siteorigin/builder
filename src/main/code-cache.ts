/**
 * The editor window's V8 code cache policy (#958). Chromium's default keeps a script's compiled code only from its
 * second run, to be used from the third, so the second launch after an update compiled the editor's scripts again.
 * Until this build's editor code has run in a window (a project shown in it, which loads the editor's own chunk), the
 * window keeps compiled code from a script's first run instead. Only until then: the policy covers every frame in the
 * window, the canvas's preview too, whose scripts the website's dev server serves from a new port each launch, so
 * keeping them would store code that is never used again.
 *
 * Which build's code is cached is noted inside Chromium's code cache folder, so a cleared cache is never taken for a
 * full one. A note that is wrong either way costs time, never correctness: Chromium checks every entry it uses.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** `webPreferences.v8CacheOptions`: Chromium's default, or code kept from a script's first run. */
export type V8CachePolicy = 'code' | 'bypassHeatCheck';

/** Beside Chromium's own `js` and `wasm` caches, so it goes when they are cleared. */
export const CODE_CACHE_NOTE = join('Code Cache', 'siteorigin-editor-build');

/** `userData` is asked for when it is first needed: the app's profile folder can be set after this is made. */
export function createEditorCodeCache(userData: () => string, build: string) {
  const file = () => join(userData(), CODE_CACHE_NOTE);
  let cached = false;
  return {
    /** The policy for an editor window made now. */
    async policy(): Promise<V8CachePolicy> {
      if (!cached) cached = (await readFile(file(), 'utf8').catch(() => null)) === build;
      return cached ? 'code' : 'bypassHeatCheck';
    },
    /** The editor's code has run in a window that kept it: later windows, and launches of this build, find it cached. */
    async ran(): Promise<void> {
      if (cached) return;
      cached = true;
      try {
        await mkdir(dirname(file()), { recursive: true });
        await writeFile(file(), build);
      } catch {
        // Not noted: the next launch keeps code from the first run again, which only costs it a little time.
      }
    }
  };
}
