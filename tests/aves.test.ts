import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { TreeStore } from '../src/stream/store.ts';
import { NONE } from '../src/stream/format.ts';
import type { AncestorEntry, ChildPreview, Manifest, Provenance } from '../src/stream/format.ts';
import type { TreeNodeInput } from '../src/tree/types.ts';
import { fitBounds, focusBounds, mapInsets } from '../src/tree/navigation.ts';

const folder = 'public/data/aves';
const manifest: Manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
const provenance: Provenance = JSON.parse(readFileSync('data/processed/opentree/aves/provenance.json', 'utf8'));
const bytes = readFileSync('data/processed/opentree/aves/nodes.json');
const source: TreeNodeInput[] = JSON.parse(bytes.toString());
const reader = async (path: string) => {
  const b = readFileSync(join(folder, path));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

test('Aves publication preserves every source label, ID, edge, and terminal count', async () => {
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.nodesSha256);
  const newick = readFileSync(join(provenance.snapshotPath, 'tree.newick'));
  assert.equal(createHash('sha256').update(newick).digest('hex'), provenance.newickSha256);
  assert.deepEqual(manifest.provenance, provenance);
  assert.ok(manifest.nodeCount > 20 * 1333);
  assert.equal(manifest.nodeCount, source.length);
  const store = new TreeStore(manifest, reader);
  const published: Awaited<ReturnType<TreeStore['node']>>[] = [];
  for (let i = 0; i < manifest.nodeCount; i++) published.push(await store.node(i));
  const original = new Map(source.map(n => [n.id, n]));
  assert.equal(new Set(published.map(n => n.summary.id)).size, source.length);
  let leaves = 0, edges = 0;
  for (const { summary: n, record: r } of published) {
    const expected = original.get(n.id)!;
    assert.ok(expected);
    for (const key of ['parentId', 'scientificName', 'ottId', 'sourceLabel', 'isSyntheticNode', 'isTerminal'] as const) {
      assert.equal(n[key], expected[key], `${n.id}: ${key}`);
    }
    assert.equal(r.parent === NONE ? null : published[r.parent].summary.id, expected.parentId);
    let child = r.firstChild, count = 0, tips = 0;
    while (child !== NONE) {
      assert.equal(published[child].record.parent, n.index);
      tips += published[child].record.leafCount;
      count++; edges++; child = published[child].record.nextSibling;
      assert.ok(count <= manifest.nodeCount);
    }
    assert.equal(r.childCount, count);
    assert.equal(r.leafCount, count ? tips : 1);
    assert.equal(n.depth, r.parent === NONE ? 0 : published[r.parent].summary.depth + 1);
    if (!count) leaves++;
    assert.ok([r.dx, r.dy, r.ratio, r.heading, ...r.bounds].every(Number.isFinite));
    assert.ok(r.ratio > 0 && r.ratio <= 1);
  }
  assert.equal(edges, source.length - 1);
  assert.equal(leaves, manifest.leafCount);
  assert.equal(leaves, 18988);
  for (let page = 0; page < manifest.pageCount; page++) {
    const bundle: AncestorEntry[] = JSON.parse(readFileSync(join(folder, manifest.version, 'ancestry', `${page}.json`), 'utf8'));
    for (const entry of bundle) {
      const node = published[entry.summary.index];
      assert.deepEqual(entry.summary, node.summary);
      for (const key of ['parent', 'dx', 'dy', 'ratio'] as const) assert.equal(entry[key], node.record[key]);
    }
    const previews: ChildPreview[] = JSON.parse(readFileSync(join(folder, manifest.version, 'details', `${page}.json`), 'utf8'));
    for (const preview of previews) {
      assert.ok(preview.children.length <= 100);
      for (const child of preview.children) {
        assert.deepEqual(child, published[child.index].summary);
        let ancestor = published[child.index].record.parent;
        while (ancestor !== preview.index) {
          assert.notEqual(ancestor, NONE);
          assert.equal(published[ancestor].summary.isSyntheticNode, true);
          ancestor = published[ancestor].record.parent;
        }
      }
    }
  }
});

test('real depth-60 bird search preserves source ancestry and renders on a small screen', async () => {
  const store = new TreeStore(manifest, reader);
  const [target] = await store.search('Camarhynchus psittacula');
  assert.equal(target.id, 'ott419363');
  const detail = await store.details(target.index);
  assert.ok(store.requests <= 8, `Deep ancestry made ${store.requests} requests`);
  assert.equal(detail.node.depth, 60);
  const original = new Map(source.map(n => [n.id, n]));
  let parent: string | null = target.id;
  const expected: string[] = [];
  while (parent) { expected.push(parent); parent = original.get(parent)!.parentId; }
  assert.deepEqual(detail.lineage.map(n => n.id), expected.reverse());
  for (const size of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    const camera = fitBounds(focusBounds(detail.focus), size, mapInsets(size, true));
    const scene = await store.view({ anchor: detail.anchor, camera, size });
    assert.ok(scene.nodes.some(n => n.id === target.id));
    assert.equal(scene.stats.limited, false);
    assert.ok(scene.lines.every(Number.isFinite));
  }
});
