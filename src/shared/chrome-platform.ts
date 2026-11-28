/**
 * The platform an automated launch draws the editor's chrome for, so a capture harness on one computer can show the
 * toolbar as it is laid out on another (no traffic-light inset and Ctrl shortcuts off macOS). With SITEORIGIN_PLATFORM
 * set to darwin, win32 or linux in a test launch, the main process passes it to the editor window as CHROME_PLATFORM_ARG
 * and the preload reports it as the platform. A normal launch ignores both and reports the real one.
 */
export const CHROME_PLATFORM_ENV = 'SITEORIGIN_PLATFORM';
export const CHROME_PLATFORM_ARG = '--siteorigin-platform=';
const PLATFORMS = ['darwin', 'win32', 'linux'];

/** The editor window's argument for the platform a test asked for, or none. */
export function chromePlatformArgs(env: Record<string, string | undefined>, automated: boolean): string[] {
  const asked = env[CHROME_PLATFORM_ENV];
  return automated && asked && PLATFORMS.includes(asked) ? [CHROME_PLATFORM_ARG + asked] : [];
}

/** The platform the editor draws for: the one its window was given, else this computer's. */
export function chromePlatform(argv: readonly string[], actual: string): string {
  const asked = argv.find((a) => a.startsWith(CHROME_PLATFORM_ARG))?.slice(CHROME_PLATFORM_ARG.length);
  return asked && PLATFORMS.includes(asked) ? asked : actual;
}
