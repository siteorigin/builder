import { Session } from 'node:inspector/promises';

/**
 * Whether what `ref` names has been collected: garbage is collected in this process (through the inspector, as the
 * perf harness collects the app's) up to `passes` times, each in a job of its own, until it has gone. A WeakRef keeps
 * its target to the end of the job that made it or read it, so the first collection waits for the next one.
 */
export async function collected(ref: WeakRef<object>, passes = 5): Promise<boolean> {
  const session = new Session();
  session.connect();
  try {
    for (let i = 0; i < passes; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await session.post('HeapProfiler.collectGarbage');
      if (ref.deref() === undefined) return true;
    }
    return false;
  } finally {
    session.disconnect();
  }
}
