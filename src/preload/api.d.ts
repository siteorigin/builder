import type { BuilderApi } from '../shared/api';
import type { PerfSent } from '../shared/perf';
declare global {
  interface Window {
    builder: BuilderApi;
    /** Present only while timing marks are on (src/shared/perf.ts). */
    builderPerf?: { send(record: PerfSent): void };
  }
}
export {};
