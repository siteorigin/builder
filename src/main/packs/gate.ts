/**
 * The theme packs are verified once per run, while the first editor window loads, instead of before it exists.
 * Verification is a trust boundary: nothing may reach a pack before it is verified. Everything that can (the
 * catalogue, opening or creating a project, export, the assistant) is reached through the editor's IPC, and every
 * request waits here until the packs are verified, then is authorized again, since its window may have closed or
 * changed page while it waited.
 *
 * No electron import: the caller passes the verification, so the gate is tested on its own.
 */
export interface PacksGate {
  /** True once verification has finished without throwing. */
  readonly verified: boolean;
  /**
   * Start verifying, once: every call while it runs, and after it succeeded, returns the same promise. It rejects with
   * what stopped it, and a call after that starts again.
   */
  verify(): Promise<void>;
  /**
   * `run` once the packs are verified: at once (synchronously) when they already are, otherwise after verification
   * and `authorize` passes again. A verification that failed rejects the requests that waited for it with its error.
   */
  after<T>(authorize: () => void, run: () => T): T | Promise<T>;
}

export function createPacksGate(load: () => Promise<unknown>): PacksGate {
  let verified = false;
  let pending: Promise<void> | null = null;
  const verify = () => {
    if (pending) return pending;
    const attempt = (async () => {
      await load();
      verified = true;
    })();
    pending = attempt;
    // Asked again after a failure, it verifies again: the editor's Reload reads the themes afresh.
    attempt.catch(() => {
      if (pending === attempt) pending = null;
    });
    return attempt;
  };
  return {
    get verified() {
      return verified;
    },
    verify,
    after(authorize, run) {
      if (verified) return run();
      return verify().then(() => {
        authorize();
        return run();
      });
    }
  };
}
