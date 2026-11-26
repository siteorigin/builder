// Runs after electron-builder lays out the app for each platform/arch.
// 1. Copies the complete npm package (including its bundled node_modules, which packaging filters drop).
// 2. Pre-downloads the website starter's exact locked dependencies for the target platform into an npm
//    cache shipped with the app, so creating a project needs no network on first use.
// 3. Writes THIRD_PARTY_NOTICES.txt beside LICENSE.txt: everything the bundles compile in, the node_modules in the
//    archive, npm, the starter's cached packages and the theme packs' fonts (build/notices.cjs).
const { cpSync, mkdtempSync, rmSync, existsSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { dirname, join } = require('node:path');
const { tmpdir } = require('node:os');
const { listPackage, extractFile } = require('@electron/asar');
const notices = require('./notices.cjs');

const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const root = join(__dirname, '..');
  const resources =
    context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
  cpSync(join(root, 'node_modules', 'npm'), join(resources, 'npm'), { recursive: true, dereference: true });

  const arch = ARCH[context.arch] ?? 'x64';
  const work = mkdtempSync(join(tmpdir(), 'so-deps-'));
  const cache = join(resources, 'npm-cache');
  rmSync(cache, { recursive: true, force: true });
  for (const f of ['package.json', 'package-lock.json']) cpSync(join(root, 'templates/sveltekit-brochure/files', f), join(work, f));
  const npmCli = join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const cpus = arch === 'universal' ? ['x64', 'arm64'] : [arch];
  // The starter's packages are read for the notices before the next CPU's install replaces them.
  const starter = [];
  for (const cpu of cpus) {
    rmSync(join(work, 'node_modules'), { recursive: true, force: true });
    execFileSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--cache=${cache}`, `--os=${context.electronPlatformName}`, `--cpu=${cpu}`], {
      cwd: work,
      stdio: 'inherit'
    });
    // Every copy is kept: the notices merge the distinct texts of one package version.
    for (const dir of notices.packagesUnder(join(work, 'node_modules'))) starter.push(notices.readPackage(dir));
  }
  rmSync(work, { recursive: true, force: true });
  if (!existsSync(cache)) throw new Error('Bundled dependency cache was not created.');

  writeNotices(root, resources, starter);

  // macOS: give every build a valid (ad-hoc) signature, sealing the resources added above. When a
  // Developer ID certificate is available, electron-builder signs again afterwards with the real identity.
  if (context.electronPlatformName === 'darwin' && process.platform === 'darwin') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  }
};

/**
 * THIRD_PARTY_NOTICES.txt in `resources`. The archive's node_modules are listed from app.asar itself, so the file covers
 * exactly the packages this platform and architecture ship; their licence texts come from the installed copies, which
 * keep the READMEs packaging leaves out.
 */
function writeNotices(root, resources, starterPackages) {
  const installed = new Map();
  for (const dir of notices.packagesUnder(join(root, 'node_modules'))) {
    try {
      const { name, version } = require(join(dir, 'package.json'));
      if (!installed.has(`${name}@${version}`)) installed.set(`${name}@${version}`, dir);
    } catch {
      // An unreadable manifest is not a package.
    }
  }
  const archive = join(resources, 'app.asar');
  const shipped = [];
  for (const entry of listPackage(archive, { isPack: false })) {
    // Entries use the host's separator, and asar looks them up by it: match on `/`, extract by the entry itself.
    const native = entry.replace(/^[\\/]+/, '');
    const rel = native.split('\\').join('/');
    // A package's own manifest (node_modules/<name>/package.json, scoped or nested), not one of its subfolders'.
    if (!/(^|\/)node_modules\/(@[^/]+\/)?[^/@][^/]*\/package\.json$/.test(rel)) continue;
    const { name, version } = JSON.parse(extractFile(archive, native).toString('utf8'));
    // The installed copy at the archive's own path, or else any installed copy of that version.
    const same = join(root, dirname(native));
    const sameManifest = existsSync(join(same, 'package.json')) ? require(join(same, 'package.json')) : null;
    const dir = sameManifest?.name === name && sameManifest?.version === version ? same : installed.get(`${name}@${version}`);
    if (!dir) throw new Error(`Third-party notices: ${name}@${version} ships in app.asar but is not installed under node_modules.`);
    shipped.push(dir);
  }
  const npm = join(resources, 'npm');
  const { text, missing } = notices.buildNotices({
    parts: {
      ...notices.bundledPackages(join(root, '.tmp', 'notices')),
      shipped,
      npm: [npm, ...notices.packagesUnder(join(npm, 'node_modules'))],
      starter: starterPackages
    },
    packsDirs: [join(resources, 'resources', 'packs'), join(resources, 'resources', 'packs-dev')]
  });
  writeFileSync(join(resources, notices.NOTICES_FILE), text);
  notices.warnMissing(missing);
}
