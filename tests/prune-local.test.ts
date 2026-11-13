import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { after, test } from 'node:test';
import { planLocalPrune, pruneLocal } from '../pipeline/prune-local.mjs';

const root = mkdtempSync(join(tmpdir(), 'tree-prune-'));
after(() => rmSync(root, { recursive: true, force: true }));
writeFileSync(join(root, 'package.json'), '{"name":"tree-of-life"}');
mkdirSync(join(root, 'public/data/life/1111111111111111'), { recursive: true });
mkdirSync(join(root, 'public/data/life/2222222222222222'), { recursive: true });
writeFileSync(join(root, 'public/data/life/manifest.json'), '{"version":"2222222222222222"}');
writeFileSync(join(root, 'public/data/life/1111111111111111/page.bin'), 'old');
writeFileSync(join(root, 'public/data/life/2222222222222222/page.bin'), 'active');
mkdirSync(join(root, '.benchmarks/case'), { recursive: true });
writeFileSync(join(root, '.benchmarks/case/page.bin'), 'fixture');
mkdirSync(join(root, '.opentree/release'), { recursive: true });
writeFileSync(join(root, '.opentree/release/source'), 'source');

test('local pruning is dry-run by default and preserves the active publication', () => {
  const targets = planLocalPrune(root).map(item => item.relative);
  assert.deepEqual(targets, ['.benchmarks', 'public/data/life/1111111111111111']);
  const report = pruneLocal(root);
  assert.equal(report.applied, false);
  assert.equal(planLocalPrune(root).length, 2);
});

test('optional cleanup scopes are explicit', () => {
  assert.deepEqual(planLocalPrune(root, { allLife: true }).map(item => item.relative),
    ['.benchmarks', 'public/data/life']);
  assert.deepEqual(planLocalPrune(root, { sourceCache: true }).map(item => item.relative),
    ['.benchmarks', '.opentree', 'public/data/life/1111111111111111']);
});

test('apply removes only planned targets', () => {
  const report = pruneLocal(root, { apply: true });
  assert.equal(report.targets.length, 2);
  assert.deepEqual(planLocalPrune(root), []);
  assert.deepEqual(planLocalPrune(root, { sourceCache: true }).map(item => item.relative), ['.opentree']);
});
