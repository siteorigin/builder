/** Types for build/notices.cjs, which the build, the packaging hook and the unit tests share. */
export interface LicenceText {
  file: string;
  text: string;
}
export interface PackageNotice {
  name: string;
  version: string;
  licence: string;
  repository: string | null;
  texts: LicenceText[];
  missing: boolean;
}
export interface FontNotice {
  name: string;
  family: string;
  licence: string;
  notice: string;
  packs: string[];
}
export interface BundledPackagesPlugin {
  name: string;
  apply: 'build';
  configResolved(config: { root?: string }): void;
  buildStart(): void;
  generateBundle(options: unknown, bundle: Record<string, { type: 'chunk' | 'asset'; moduleIds?: string[]; modules?: Record<string, unknown>; originalFileNames?: string[] }>): void;
  writeBundle(): void;
}
export declare const LICENCE_FILE: RegExp;
export declare const CODE_FILE: RegExp;
export declare function findInstalled(name: string, from: string): string | null;
export declare function virtualProvider(id: string, root: string): { dir: string; notice?: undefined } | { notice: PackageNotice; dir?: undefined } | null;
export declare const NOTICES_FILE: string;
export declare const PARTS: Record<string, string>;
export declare function packageRootOf(id: string): string | null;
export declare function declaredLicence(pkg: Record<string, unknown>): string;
export declare function readPackage(dir: string): PackageNotice;
export declare function licenceFiles(dir: string): string[];
export declare function readmeLicence(dir: string): (LicenceText & { complete: boolean }) | null;
export declare function packagesUnder(nodeModules: string): string[];
export declare function bundledPackagesPlugin(target: string, file: string): BundledPackagesPlugin;
export declare function bundledPackages(manifestDir: string, targets?: string[]): Record<string, (string | PackageNotice)[]>;
export declare function packFonts(packsDirs: string[]): FontNotice[];
export declare function renderNotices(input: { packages: { pkg: PackageNotice; parts: string[] }[]; fonts: FontNotice[] }): string;
export declare function buildNotices(input: { parts: Record<string, (string | PackageNotice)[]>; packsDirs?: string[] }): { text: string; missing: string[] };
export declare function productionPackages(root: string): string[];
export declare function warnMissing(missing: string[], log?: (message: string) => void): void;
