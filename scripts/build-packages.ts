// Builds the publishable packages: compile src → JS + .d.ts, stage a package.json whose exports
// point at dist/, then `npm pack` each into dist/release/. Dev and tests keep running the .ts
// sources directly; only release artifacts are compiled (Node will not strip types in node_modules).
// Usage: node scripts/build-packages.ts
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = ['core', 'slack-adapter', 'matrix-gateway', 'conformance'];
const root = new URL('..', import.meta.url).pathname;
const run = (cmd: string, args: string[], cwd = root) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

rmSync(join(root, 'build'), { recursive: true, force: true });
const out = join(root, 'dist/release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
run(join(root, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.build.json']);

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
for (const name of PACKAGES) {
  const src = join(root, 'packages', name);
  const stage = join(root, 'build/pkg', name);
  mkdirSync(stage, { recursive: true });
  cpSync(join(root, 'build/tsc', name, 'src'), join(stage, 'dist'), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const js = (p: string) => p.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js');
  pkg.version = rootPkg.version;
  pkg.exports = { '.': { types: './dist/index.d.ts', default: './dist/index.js' } };
  if (pkg.bin) pkg.bin = Object.fromEntries(Object.entries(pkg.bin as Record<string, string>).map(([k, v]) => [k, js(v)]));
  if (pkg.dependencies?.['@intertie/core']) pkg.dependencies['@intertie/core'] = rootPkg.version;
  pkg.files = ['dist', 'README.md', 'LICENSE', ...(existsSync(join(src, 'manifest.yaml')) ? ['manifest.yaml'] : [])];
  pkg.repository = { type: 'git', url: 'git+https://github.com/Hakiwen/intertie.git', directory: `packages/${name}` };
  pkg.homepage = 'https://github.com/Hakiwen/intertie';
  pkg.bugs = 'https://github.com/Hakiwen/intertie/issues';
  delete pkg.private;
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  cpSync(join(root, 'LICENSE'), join(stage, 'LICENSE'));
  if (existsSync(join(src, 'manifest.yaml'))) cpSync(join(src, 'manifest.yaml'), join(stage, 'manifest.yaml'));
  writeFileSync(join(stage, 'README.md'), `# ${pkg.name}\n\n${pkg.description}\n\nPart of [Intertie](https://github.com/Hakiwen/intertie), an open protocol for shared channels between organizations, with no intermediary. Docs, spec and release verification: see the repository.\n`);
  run('npm', ['pack', '--quiet', '--pack-destination', out], stage);
}
const sums = readdirSync(out).filter((f) => f.endsWith('.tgz')).sort()
  .map((f) => `${createHash('sha256').update(readFileSync(join(out, f))).digest('hex')}  ${f}`);
writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(sums.join('\n'));
