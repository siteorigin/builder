// Runs after electron-builder lays out the app for each platform/arch.
// 1. Copies the complete npm package (including its bundled node_modules, which packaging filters drop).
// 2. Pre-downloads the website starter's exact locked dependencies for the target platform into an npm
//    cache shipped with the app, so creating a project needs no network on first use.
const { cpSync, mkdtempSync, rmSync, existsSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

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
  for (const cpu of cpus) {
    rmSync(join(work, 'node_modules'), { recursive: true, force: true });
    execFileSync(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', `--cache=${cache}`, `--os=${context.electronPlatformName}`, `--cpu=${cpu}`], {
      cwd: work,
      stdio: 'inherit'
    });
  }
  rmSync(work, { recursive: true, force: true });
  if (!existsSync(cache)) throw new Error('Bundled dependency cache was not created.');

  // macOS: give every build a valid (ad-hoc) signature, sealing the resources added above. When a
  // Developer ID certificate is available, electron-builder signs again afterwards with the real identity.
  if (context.electronPlatformName === 'darwin' && process.platform === 'darwin') {
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  }
};
