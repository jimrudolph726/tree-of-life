/** Safe, repository-scoped cleanup for reproducible local data.
 *
 * Dry-run is the default. `--apply` removes obsolete full-tree versions and
 * benchmark fixtures. `--all-life` also removes the active local full-tree
 * publication; ordinary development continues to use the CloudFront proxy.
 * `--source-cache` additionally removes the redownloadable OpenTree cache.
 */
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function repositoryRoot(root) {
  const resolved = resolve(root);
  const packageFile = join(resolved, 'package.json');
  let value;
  try { value = JSON.parse(readFileSync(packageFile, 'utf8')); } catch { throw new Error(`Not a project root: ${resolved}`); }
  if (value.name !== 'tree-of-life') throw new Error(`Refusing to clean an unexpected project: ${resolved}`);
  return resolved;
}

function safeDirectory(root, path, reason) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Unsafe cleanup target: ${absolute}`);
  let stat;
  try { stat = lstatSync(absolute); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Cleanup target is not a real directory: ${absolute}`);
  return { path: absolute, relative: rel.replaceAll('\\', '/'), reason };
}

export function planLocalPrune(root, { allLife = false, sourceCache = false } = {}) {
  root = repositoryRoot(root);
  const targets = [];
  const add = (path, reason) => { const target = safeDirectory(root, path, reason); if (target) targets.push(target); };
  add('.benchmarks', 'reproducible benchmark fixtures');
  if (allLife) {
    add('public/data/life', 'complete local tree publication; development uses CloudFront');
  } else {
    const folder = join(root, 'public', 'data', 'life');
    let active;
    try { active = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')).version; } catch {}
    if (active && /^[a-f0-9]{16}$/.test(active)) {
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name) && entry.name !== active) {
          add(join('public', 'data', 'life', entry.name), `obsolete tree publication; active version is ${active}`);
        }
      }
    }
    for (const entry of (() => { try { return readdirSync(folder, { withFileTypes: true }); } catch { return []; } })()) {
      if (entry.isDirectory() && (entry.name === '.build-stage' || entry.name.startsWith('.building-'))) {
        add(join('public', 'data', 'life', entry.name), 'interrupted tree build staging directory');
      }
    }
  }
  if (sourceCache) add('.opentree', 'redownloadable OpenTree source cache');
  return targets.sort((a, b) => a.relative.localeCompare(b.relative));
}

function measure(path) {
  let files = 0, bytes = 0;
  const pending = [path];
  while (pending.length) {
    for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
      const child = join(entry.parentPath, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to traverse a symlink: ${child}`);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile()) { files++; bytes += lstatSync(child).size; }
    }
  }
  return { files, bytes };
}

export function pruneLocal(root, options = {}) {
  const apply = options.apply === true;
  const targets = planLocalPrune(root, options).map(target => ({ ...target, ...measure(target.path) }));
  if (apply) for (const target of targets) rmSync(target.path, { recursive: true, force: false });
  return { applied: apply, targets, files: targets.reduce((n, item) => n + item.files, 0),
    bytes: targets.reduce((n, item) => n + item.bytes, 0) };
}

function formatBytes(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const known = new Set(['--apply', '--all-life', '--source-cache']);
  const unknown = process.argv.slice(2).filter(value => !known.has(value));
  if (unknown.length) throw new Error(`Unknown option: ${unknown.join(', ')}`);
  const report = pruneLocal(process.cwd(), { apply: process.argv.includes('--apply'),
    allLife: process.argv.includes('--all-life'), sourceCache: process.argv.includes('--source-cache') });
  for (const target of report.targets) console.log(`${report.applied ? 'Removed' : 'Would remove'} ${target.relative} — ${target.reason} (${target.files.toLocaleString()} files, ${formatBytes(target.bytes)})`);
  if (!report.targets.length) console.log('Nothing to prune.');
  else console.log(`${report.applied ? 'Recovered' : 'Dry run:'} ${formatBytes(report.bytes)} across ${report.files.toLocaleString()} files.`);
  if (!report.applied && report.targets.length) {
    const scope = [process.argv.includes('--all-life') ? '--all-life' : '',
      process.argv.includes('--source-cache') ? '--source-cache' : ''].filter(Boolean).join(' ');
    console.log(`Review the targets, then rerun with: npm run clean:local-data -- --apply${scope ? ` ${scope}` : ''}`);
  }
}
